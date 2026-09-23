/**
 * Cognito pre-signup trigger (design §6.2, §10): server-side COPPA gate.
 * Rejects sign-ups with a missing/malformed birthdate or age < 13. The thrown
 * message surfaces to the client as the failure reason. No auto-confirm.
 *
 * Federated sign-ins (Apple/Google) carry no birthdate — they pass here and
 * the age gate moves to the in-app DOB step: the USER row starts is18plus
 * false (post-confirmation), so voting stays locked until a birthdate lands.
 */
import type { PreSignUpTriggerHandler } from "aws-lambda";
import { computeAge } from "../../lib/age";

const MIN_AGE = 13;

export const handler: PreSignUpTriggerHandler = async (event) => {
  if (event.triggerSource === "PreSignUp_ExternalProvider") {
    return event;
  }

  const birthdate = event.request.userAttributes["birthdate"];
  const age = birthdate ? computeAge(birthdate) : null;

  if (age === null) {
    throw new Error("BIRTHDATE_REQUIRED");
  }
  if (age < MIN_AGE) {
    throw new Error("AGE_MINIMUM");
  }

  return event;
};
