/**
 * Signed URLs on the partner download distribution (edge stack). The
 * distribution's domain and CloudFront key-pair id are published by the edge
 * stack as SSM parameters, and the RSA private key sits in Secrets Manager
 * (written once by scripts/partner-dl-keypair.ts, never in git), so the API
 * stack signs without a stack dependency on the edge stack.
 *
 * All three are read once per container. Tests inject values through the
 * plain environment variables instead (PARTNER_DL_DOMAIN et al).
 */
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { createPrivateKey } from "node:crypto";

export interface PartnerSigner {
  /** the distribution's host name, e.g. d123.cloudfront.net */
  domain: string;
  /** Sign a distribution path (`/{id}/master.mp4`) until `expiresAt`. */
  sign: (path: string, expiresAt: Date) => string;
}

let cached: Promise<PartnerSigner> | undefined;

async function ssmValue(name: string): Promise<string> {
  const out = await new SSMClient({}).send(new GetParameterCommand({ Name: name }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty — has the edge stack deployed the partner distribution?`);
  return value;
}

async function secretValue(id: string): Promise<string> {
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: id }));
  if (!out.SecretString) throw new Error(`secret ${id} has no string value — run scripts/partner-dl-keypair.ts`);
  return out.SecretString;
}

async function load(): Promise<PartnerSigner> {
  const domain = process.env.PARTNER_DL_DOMAIN ?? (await ssmValue(process.env.PARTNER_DL_DOMAIN_PARAM ?? ""));
  const keyPairId =
    process.env.PARTNER_DL_KEY_PAIR_ID ?? (await ssmValue(process.env.PARTNER_DL_KEYPAIR_PARAM ?? ""));
  const privateKeyPem =
    process.env.PARTNER_DL_PRIVATE_KEY ?? (await secretValue(process.env.PARTNER_DL_PRIVATE_KEY_SECRET ?? ""));
  // Parsed once per container. Handing the signer the PEM string makes Node
  // re-parse the key on every signature; at three files an asset and 100
  // assets a page that was most of a 7-second list call on a 256 MB Lambda.
  // crypto.sign accepts a KeyObject wherever it accepts a PEM.
  const privateKey = createPrivateKey(privateKeyPem) as unknown as string;
  return {
    domain,
    sign: (path, expiresAt) =>
      getSignedUrl({
        url: `https://${domain}${path}`,
        keyPairId,
        privateKey,
        dateLessThan: expiresAt.toISOString(),
      }),
  };
}

/** The container-cached signer. A failed load is not cached, so the next call retries. */
export function getPartnerSigner(): Promise<PartnerSigner> {
  if (!cached) {
    cached = load().catch((err) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

/** Test seam. */
export function resetPartnerSigner(): void {
  cached = undefined;
}
