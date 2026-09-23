import { join } from "node:path";
import { CfnOutput, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import {
  INVITE_EMAIL_SUBJECT,
  VERIFICATION_EMAIL_SUBJECT,
  inviteEmailBody,
  verificationEmailBody,
} from "./email-templates";
import { makeFn } from "./fn";

export interface FoundationStackProps extends StackProps {
  stage: string;
}

/**
 * Stateful core (design §5, §6.2): the DynamoDB single table and the Cognito
 * user pool with its three lifecycle triggers. Everything else builds on these.
 */
export class FoundationStack extends Stack {
  public readonly table: dynamodb.Table;
  /**
   * The SSO-capable pool ("UserPoolV2" logical id; it replaced the original
   * pool). birthdate is OPTIONAL: Apple/Google send none, and
   * Cognito hard-fails federated sign-ups missing a required attribute
   * (required flags are immutable, hence the replacement). The COPPA/18+
   * gates were never attribute-based anyway: they live on the USER row
   * (pre-signup for native sign-ups, the in-app DOB step for SSO).
   */
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  /**
   * Dev-only app client for CLI integration tests (USER_PASSWORD_AUTH — no
   * SRP dance from a shell). Never created outside dev; the API stack adds
   * its id to the JWT authorizer audience only when it exists.
   */
  public readonly testClient: cognito.UserPoolClient | undefined;
  /** SRP-only, secret-free client for the website's sign-in. */
  public readonly webClient: cognito.UserPoolClient;
  /** Salt for partner API key hashes (partner content API) — shared by the api and admin stacks. */
  public readonly partnerKeyPepper: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const { stage } = props;

    // Stateful resources survive stack deletion everywhere except dev.
    const removalPolicy = stage === "dev" ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // ── DynamoDB single table (design §5) ──────────────────────────────────
    this.table = new dynamodb.Table(this, "Table", {
      tableName: `niltv-${stage}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      // 35-day continuous backups. The table is the system of record for
      // votes, follows and the whole content catalogue; deletionProtection
      // guards the table object, this guards the DATA.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Real deletion guard outside dev (omit entirely in dev so the template
      // carries no DeletionProtectionEnabled there).
      deletionProtection: stage !== "dev" ? true : undefined,
      removalPolicy,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: dynamodb.AttributeType.STRING },
    });

    // GSI3 (partner content API): the sparse syndication index. Only content
    // rows that have been published with an owned/licensed rights record
    // carry GSI3 keys (SYND#ALL / {syndicationUpdatedAt}#{id}); withdrawn
    // rows keep theirs as tombstones. See src/lib/syndication.ts.
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI3",
      partitionKey: { name: "GSI3PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI3SK", type: dynamodb.AttributeType.STRING },
    });

    // ── Partner API key pepper (partner content API) ───────────────────────
    // Salt for the SHA-256 of every partner API key. Lives here, in the
    // stateful core, because both the api stack (authorizer) and the admin
    // stack (key issue/rotate) hash with it: a table dump plus the pepper is
    // what an attacker needs, and the pepper never leaves Secrets Manager
    // except as a deploy-time dynamic reference into those two functions.
    this.partnerKeyPepper = new secretsmanager.Secret(this, "PartnerKeyPepper", {
      secretName: `niltv-${stage}-partner-key-pepper`,
      description: "Salt for partner API key hashes (PARTNERKEY#{hash} rows)",
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      removalPolicy,
    });

    // ── Cognito lifecycle triggers (design §6.2) ───────────────────────────
    const cognitoTrigger = (constructId: string, name: string, entryFile: string): NodejsFunction =>
      makeFn(this, constructId, {
        stage,
        name,
        entry: join(__dirname, "..", "src", "handlers", "cognito", entryFile),
      });

    const preSignUp = cognitoTrigger("PreSignUpFn", "pre-signup", "pre-signup.ts");
    const postConfirmation = cognitoTrigger("PostConfirmationFn", "post-confirmation", "post-confirmation.ts");
    const preTokenGeneration = cognitoTrigger("PreTokenFn", "pre-token", "pre-token.ts");

    // pre-token stamps claims from the stored USER row (source of truth frozen
    // at confirmation) and heals a missing one — federated sign-ins never fire
    // post-confirmation (see pre-token.ts). Scoped to USER#* keys.
    preTokenGeneration.addEnvironment("TABLE_NAME", this.table.tableName);
    preTokenGeneration.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
        },
      }),
    );

    // post-confirmation writes the USER# profile row (design §6.2) — and only
    // that: PutItem scoped to USER#* partition keys, nothing else on the table.
    postConfirmation.addEnvironment("TABLE_NAME", this.table.tableName);
    postConfirmation.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
        },
      }),
    );

    // ── App client attribute permissions (shared by every client) ─────────
    // Attribute permissions are explicit: the client may write name/email and
    // birthdate — birthdate MUST be writable because Cognito requires self-
    // signup clients to have write access to required attributes. The age gate
    // is immune to later birthdate edits anyway: is18plus is frozen onto the
    // USER row at confirmation and pre-token stamps claims from that row, not
    // the live attribute. custom:role is never client-writable.
    const clientWriteAttributes = new cognito.ClientAttributes().withStandardAttributes({
      fullname: true,
      email: true,
      birthdate: true,
    });
    const clientReadAttributes = new cognito.ClientAttributes().withStandardAttributes({
      fullname: true,
      email: true,
      emailVerified: true,
      birthdate: true,
      preferredUsername: true,
      profilePicture: true,
    });

    // Email art is served from our own CDN; same per-stage context the media
    // handlers use, so no template is welded to one stage's domain. Absent →
    // the shell falls back to the text wordmark rather than a broken image.
    const cfDomain = this.node.tryGetContext(`niltv:cfDomain:${stage}`) as string | undefined;
    const emailLogoBase = cfDomain ? `https://${cfDomain}` : undefined;

    // ── Cognito user pool (see the userPool prop doc for the V2 history) ───
    this.userPool = new cognito.UserPool(this, "UserPoolV2", {
      userPoolName: `niltv-${stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        // Optional (the V1→V2 reason): Apple/Google send no birthdate. Email
        // sign-up still collects it (client + pre-signup enforce); SSO users
        // provide it in-app before anything age-gated (USER row is the truth).
        birthdate: { required: false, mutable: true },
      },
      customAttributes: {
        role: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      lambdaTriggers: {
        preSignUp,
        postConfirmation,
        preTokenGeneration,
      },
      // Branded sender through SES (niltv.com is DKIM-verified in this
      // account) — the default no-reply@verificationemail.com sender lands in
      // spam and caps at 50/day. Routed through the configuration set so every
      // send is tracked for bounces and complaints (SNS → niltv-ses-events).
      email: cognito.UserPoolEmail.withSES({
        fromEmail: "no-reply@niltv.com",
        fromName: "NILTV",
        sesVerifiedDomain: "niltv.com",
        configurationSetName: "niltv-transactional",
      }),
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
        emailSubject: VERIFICATION_EMAIL_SUBJECT,
        emailBody: verificationEmailBody(emailLogoBase),
      },
      userInvitation: {
        emailSubject: INVITE_EMAIL_SUBJECT,
        emailBody: inviteEmailBody(emailLogoBase),
      },
      deletionProtection: stage !== "dev" ? true : undefined,
      removalPolicy,
    });

    // ── Hosted-UI domain (SSO callback host, design §6.2 federation) ───────
    // Apple/Google hand the OAuth response to
    // https://niltv-{stage}.auth.{region}.amazoncognito.com/oauth2/idpresponse;
    // this domain is what the Apple Services ID / Google client register.
    this.userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: `niltv-${stage}` },
    });

    new cognito.CfnUserPoolGroup(this, "StaffGroupV2", {
      userPoolId: this.userPool.userPoolId,
      groupName: "staff",
      description: "Staff members allowed to call the niltv admin API",
    });

    // ── Federated identity providers (design §6.2) ─────────────────────────
    // Secrets live in Secrets Manager only — never in git or the template.
    const appleIdp = new cognito.UserPoolIdentityProviderApple(this, "AppleIdP", {
      userPool: this.userPool,
      clientId: "com.niltv.app.signin", // Services ID
      teamId: "R8DXFFPKM5",
      keyId: "P2LSNBZYN5",
      privateKeyValue: SecretValue.secretsManager("niltv/apple-signin-key"),
      scopes: ["name", "email"],
      attributeMapping: {
        email: cognito.ProviderAttribute.APPLE_EMAIL,
        fullname: cognito.ProviderAttribute.APPLE_NAME,
      },
    });
    const googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, "GoogleIdP", {
      userPool: this.userPool,
      clientId: "841447330525-kp2m2i3h18atob9rrv0etcnun63dfmfu.apps.googleusercontent.com",
      clientSecretValue: SecretValue.secretsManager("niltv/google-oauth", {
        jsonField: "clientSecret",
      }),
      scopes: ["openid", "email", "profile"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
        profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
      },
    });

    this.userPoolClient = this.userPool.addClient("MobileClient", {
      userPoolClientName: `niltv-${stage}-mobile`,
      generateSecret: false,
      // generic errors for unknown users - sign-in and forgot-password do
      // not reveal which emails have accounts
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true },
      // Hosted-UI code flow: the app opens /oauth2/authorize with
      // identity_provider=SignInWithApple|Google and receives the code on the
      // custom scheme; COGNITO stays listed so SRP sessions coexist.
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ["niltv://auth/callback"],
        logoutUrls: ["niltv://auth/signout"],
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        cognito.UserPoolClientIdentityProvider.APPLE,
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      ],
      writeAttributes: clientWriteAttributes,
      readAttributes: clientReadAttributes,
    });
    // The client references both providers — create them first.
    this.userPoolClient.node.addDependency(appleIdp, googleIdp);

    if (stage === "dev") {
      this.testClient = this.userPool.addClient("TestClient", {
        userPoolClientName: `niltv-${stage}-test`,
        generateSecret: false,
        preventUserExistenceErrors: true,
        // without this CDK enables implicit + code OAuth
        // flows with an https://example.com callback by default - a token
        // could be minted to a host we do not own. Password-flow only.
        disableOAuth: true,
        authFlows: { userPassword: true },
        writeAttributes: clientWriteAttributes,
        readAttributes: clientReadAttributes,
      });
      new CfnOutput(this, "TestClientId", { value: this.testClient.userPoolClientId });
    }

    // The website's client: SRP only, no secret, no OAuth surface, generic
    // user-existence errors.
    this.webClient = this.userPool.addClient("WebClient", {
      userPoolClientName: `niltv-${stage}-web`,
      generateSecret: false,
      preventUserExistenceErrors: true,
      disableOAuth: true,
      authFlows: { userSrp: true },
      writeAttributes: clientWriteAttributes,
      readAttributes: clientReadAttributes,
    });
    new CfnOutput(this, "WebClientId", { value: this.webClient.userPoolClientId });

    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });

    new CfnOutput(this, "TableName", { value: this.table.tableName });
  }
}
