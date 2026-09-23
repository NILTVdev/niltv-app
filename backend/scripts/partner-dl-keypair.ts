/**
 * Generate the CloudFront signing key pair for the partner download
 * distribution (partner content API).
 *
 *   npx tsx scripts/partner-dl-keypair.ts --stage dev
 *
 * Writes the PUBLIC key to lib/keys/partner-dl.{stage}.pub.pem (committed —
 * the edge stack reads it at synth to create the CloudFront public key and
 * key group) and stores the PRIVATE key in Secrets Manager as
 * niltv/{stage}/partner-dl-private-key (never on disk, never in git). Re-run
 * to rotate: redeploy the edge stack afterwards so the new public key is
 * trusted; URLs signed with the old key stop validating at that moment.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CreateSecretCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export const partnerDlSecretName = (stage: string): string => `niltv/${stage}/partner-dl-private-key`;

async function main(): Promise<void> {
  const stage = arg("stage");
  if (!stage || !/^[a-z]+$/.test(stage)) throw new Error("usage: partner-dl-keypair.ts --stage <dev|prod>");

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const keysDir = join(__dirname, "..", "lib", "keys");
  mkdirSync(keysDir, { recursive: true });
  const publicPath = join(keysDir, `partner-dl.${stage}.pub.pem`);
  writeFileSync(publicPath, publicKey, { encoding: "utf8" });

  const client = new SecretsManagerClient({ region: "us-east-1" });
  const name = partnerDlSecretName(stage);
  try {
    await client.send(
      new CreateSecretCommand({
        Name: name,
        Description: `RSA private key signing partner download URLs (niltv-${stage}); public half in backend/lib/keys`,
        SecretString: privateKey,
      }),
    );
    console.log(`created secret ${name}`);
  } catch (err) {
    if (!(err instanceof ResourceExistsException)) throw err;
    await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: privateKey }));
    console.log(`rotated secret ${name}`);
  }
  console.log(`wrote ${publicPath}`);
  console.log("next: cdk deploy niltv-" + stage + "-edge (trusts the new public key), then the api and partner stacks");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
