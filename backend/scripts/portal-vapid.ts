/**
 * Create the web push (VAPID) key pair for a stage, in SSM:
 *
 *   /niltv/{stage}/portal-vapid-public    String, handed to browsers
 *   /niltv/{stage}/portal-vapid-private   SecureString, read by portal-notify only
 *
 *   npx tsx scripts/portal-vapid.ts --stage dev
 *   npx tsx scripts/portal-vapid.ts --stage dev --rotate
 *
 * Refuses to replace existing keys without --rotate: new keys cut off every
 * browser that subscribed with the old ones (they subscribe again on their
 * next visit). Prod needs --confirm-prod. Push still stays off until an
 * admin turns it on in Settings.
 */
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import webpush from "web-push";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function exists(ssm: SSMClient, name: string): Promise<boolean> {
  try {
    await ssm.send(new GetParameterCommand({ Name: name }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ParameterNotFound") return false;
    throw err;
  }
}

async function main(): Promise<void> {
  const stage = arg("stage") ?? "dev";
  if (stage === "prod" && !flag("confirm-prod")) throw new Error("refusing prod without --confirm-prod");
  const publicName = `/niltv/${stage}/portal-vapid-public`;
  const privateName = `/niltv/${stage}/portal-vapid-private`;
  const ssm = new SSMClient({ region: "us-east-1" });

  const present = (await exists(ssm, publicName)) || (await exists(ssm, privateName));
  if (present && !flag("rotate")) {
    throw new Error(`push keys already exist for ${stage}; pass --rotate to replace them (every browser resubscribes)`);
  }

  const keys = webpush.generateVAPIDKeys();
  await ssm.send(
    new PutParameterCommand({
      Name: privateName,
      Value: keys.privateKey,
      Type: "SecureString",
      Overwrite: present,
      Description: "NIL TV Portal web push private key (portal-notify only)",
    }),
  );
  await ssm.send(
    new PutParameterCommand({
      Name: publicName,
      Value: keys.publicKey,
      Type: "String",
      Overwrite: present,
      Description: "NIL TV Portal web push public key",
    }),
  );
  console.log(`${present ? "rotated" : "created"} push keys for ${stage}`);
  console.log(`public key: ${keys.publicKey}`);
  console.log("Lambdas pick them up within 5 minutes. Turn push on in Settings when testing is done.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
