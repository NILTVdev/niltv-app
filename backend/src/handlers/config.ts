/**
 * GET /v1/config — remote config for the app (design §4.1, §9).
 *
 * Reads the CONFIG#app/META item and merges it over the AppConfig schema
 * defaults (stored fields win). Config must never take the app down: any
 * DynamoDB/parse failure logs and serves pure defaults with a 200.
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AppConfig, ConfigResponse } from "@niltv/types";
import type {
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { configKey, getDocClient } from "../lib/db";
import { requireOriginVerify } from "../lib/origin";

const API_VERSION = "v1";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) {
    const forbidden: APIGatewayProxyStructuredResultV2 = {
      statusCode: 403,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "FORBIDDEN" }),
    };
    return forbidden;
  }

  let config = AppConfig.parse({});

  try {
    const { Item } = await getDocClient().send(
      new GetCommand({
        TableName: process.env.TABLE_NAME ?? "",
        Key: configKey(),
      }),
    );
    if (Item) {
      // Shallow merge: stored fields win; zod strips PK/SK/unknown keys and
      // fills any gaps (e.g. a missing flag) with schema defaults.
      config = AppConfig.parse({ ...config, ...Item });
    }
  } catch (err) {
    console.error("config: DynamoDB read failed — serving defaults", err);
    config = AppConfig.parse({});
  }

  const body = ConfigResponse.parse({
    ...config,
    apiVersion: API_VERSION,
    serverTime: new Date().toISOString(),
  });

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
    },
    body: JSON.stringify(body),
  };
};
