import { Ionicons } from "@expo/vector-icons";
import { useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import {
  cognitoErrorCode,
  confirmPasswordReset,
  confirmSignUp,
  requestPasswordReset,
  resendCode,
  signIn,
  signUp,
} from "@/auth/cognito";
import { useAuthStore } from "@/auth/store";
import { GoldButton } from "@/components/GoldButton";
import { Sheet } from "@/components/Sheet";
import { goBack } from "@/lib/navigation";
import { track } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

/** Muted red for inline error copy. */
const ERROR_RED = "#b04a3f";

type Mode = "signIn" | "signUp" | "confirm" | "resetRequest" | "resetConfirm";
type SignUpStep = 1 | 2 | 3;
type DobPicker = "month" | "day" | "year";

const TITLES: Record<Mode, string> = {
  signIn: "Welcome back",
  signUp: "Create your account",
  confirm: "Check your email",
  resetRequest: "Reset your password",
  resetConfirm: "Check your email",
};

/** Map Cognito failures to friendly copy; unknowns get a generic line. */
/** Mirrors the pool's password policy (foundation-stack.ts) — keep in sync. */
const PASSWORD_RULES_MESSAGE =
  "Passwords need 8+ characters with an uppercase letter, a lowercase letter, and a number.";

/** Client-side mirror of the Cognito password policy: [] means acceptable. */
function passwordIssues(pw: string): string[] {
  const issues: string[] = [];
  if (pw.length < 8) issues.push("8+ characters");
  if (!/[A-Z]/.test(pw)) issues.push("an uppercase letter");
  if (!/[a-z]/.test(pw)) issues.push("a lowercase letter");
  if (!/[0-9]/.test(pw)) issues.push("a number");
  return issues;
}

/** Live checklist rows on the password step, driven by passwordIssues(). */
const PASSWORD_CHECKS: { issue: string; label: string }[] = [
  { issue: "8+ characters", label: "8+ characters" },
  { issue: "an uppercase letter", label: "An uppercase letter" },
  { issue: "a lowercase letter", label: "A lowercase letter" },
  { issue: "a number", label: "A number" },
];

function friendlyError(error: unknown): string {
  const code = cognitoErrorCode(error);
  const message = error instanceof Error ? error.message : "";
  // Pre-signup trigger rejects under-13 birthdates with AGE_MINIMUM (server-enforced age gate).
  if (code === "UserLambdaValidationException" && message.includes("AGE_MINIMUM")) {
    return "You must be 13 or older to create an account";
  }
  switch (code) {
    case "UsernameExistsException":
      return "An account with this email already exists. Try signing in instead.";
    case "NotAuthorizedException":
    case "UserNotFoundException":
      return "Incorrect email or password.";
    case "CodeMismatchException":
      return "That code doesn't match. Double-check and try again.";
    case "ExpiredCodeException":
      return "That code has expired. Tap Resend to get a fresh one.";
    case "InvalidPasswordException":
      return PASSWORD_RULES_MESSAGE;
    case "InvalidParameterException":
      return "Please double-check your details and try again.";
    case "LimitExceededException":
    case "TooManyRequestsException":
      return "Too many attempts. Wait a moment and try again.";
    case "NetworkError":
      return "Can't reach NILTV. Check your connection and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/**
 * Reset-flow errors. The Cognito clients run with
 * preventUserExistenceErrors, so an unknown email no longer surfaces as
 * UserNotFoundException (the request looks successful instead). The branch
 * below is kept for any client still on the legacy setting.
 */
function friendlyResetError(error: unknown): string {
  if (cognitoErrorCode(error) === "UserNotFoundException") {
    return "We couldn't find an account with that email.";
  }
  return friendlyError(error);
}

const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Inline DOB validation; the server's pre-signup trigger is the enforcement. */
function validateDob(dob: string): { ok: true } | { ok: false; message: string } {
  if (!DOB_RE.test(dob)) {
    return { ok: false, message: "Enter your birthday as YYYY-MM-DD (e.g. 2008-04-21)." };
  }
  const [y = 0, m = 0, d = 0] = dob.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const isReal =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  if (!isReal || y < 1900) return { ok: false, message: "That doesn't look like a real date." };

  const now = new Date();
  if (date.getTime() > now.getTime()) {
    return { ok: false, message: "That date is in the future." };
  }
  let age = now.getUTCFullYear() - y;
  const hadBirthday =
    now.getUTCMonth() > m - 1 || (now.getUTCMonth() === m - 1 && now.getUTCDate() >= d);
  if (!hadBirthday) age -= 1;
  if (age < 13) {
    // Friendly under-13 block; Cognito's pre-signup trigger enforces it server-side.
    return {
      ok: false,
      message:
        "NILTV is for fans 13 and up. We can't create your account just yet. See you soon!",
    };
  }
  return { ok: true };
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Years for the birthday picker: current year down to 1900 (validateDob's floor). */
const YEARS: number[] = [];
for (let y = new Date().getFullYear(); y >= 1900; y--) YEARS.push(y);

/** Fixed picker row height so the sheet can scroll straight to the selection. */
const OPTION_ROW_HEIGHT = 46;

/**
 * Days in a 1-based month. Before a year is chosen a leap year stands in, so
 * February keeps 29 selectable; a later non-leap year pick clamps it.
 */
function daysInMonth(month: number | null, year: number | null): number {
  if (month == null) return 31;
  return new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate();
}

/** One tappable birthday field (Month / Day / Year) — opens its picker sheet. */
function DobField({
  label,
  value,
  onPress,
  disabled,
  style,
}: {
  label: string;
  value: string | null;
  onPress: () => void;
  disabled: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : `${label}, not set`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.dobField,
        { borderColor: t.line, backgroundColor: t.inset },
        pressed && { opacity: 0.8 },
        disabled && { opacity: 0.55 },
        style,
      ]}
    >
      <Text style={[styles.dobFieldLabel, { color: t.subtext }]}>{label}</Text>
      <Text
        numberOfLines={1}
        style={[styles.dobFieldValue, { color: value ? t.text : t.subtext }]}
      >
        {value ?? "Select"}
      </Text>
    </Pressable>
  );
}

/** One row in the picker sheet's option list. */
function OptionRow({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.optionRow, pressed && { opacity: 0.7 }]}
    >
      <Text
        style={[
          styles.optionLabel,
          {
            color: selected ? t.accent : t.text,
            fontFamily: selected ? tokens.font.bold : tokens.font.regular,
          },
        ]}
      >
        {label}
      </Text>
      {selected ? <Ionicons name="checkmark" size={18} color={t.accent} /> : null}
    </Pressable>
  );
}

/** Live password requirements checklist (sign-up step 2 and reset-confirm). */
function PasswordChecklist({
  issues,
  passwordsMatch,
}: {
  issues: string[];
  passwordsMatch: boolean;
}) {
  const t = useTheme();
  return (
    <View style={styles.checkList}>
      {PASSWORD_CHECKS.map(({ issue, label }) => {
        const met = !issues.includes(issue);
        return (
          <View
            key={issue}
            style={styles.checkRow}
            accessible
            accessibilityLabel={`${label}, ${met ? "done" : "not yet"}`}
          >
            <Ionicons
              name={met ? "checkmark-circle" : "ellipse-outline"}
              size={18}
              color={met ? t.accent : t.subtext}
            />
            <Text style={[styles.checkLabel, { color: met ? t.text : t.subtext }]}>
              {label}
            </Text>
          </View>
        );
      })}
      <View
        style={styles.checkRow}
        accessible
        accessibilityLabel={`Passwords match, ${passwordsMatch ? "done" : "not yet"}`}
      >
        <Ionicons
          name={passwordsMatch ? "checkmark-circle" : "ellipse-outline"}
          size={18}
          color={passwordsMatch ? t.accent : t.subtext}
        />
        <Text style={[styles.checkLabel, { color: passwordsMatch ? t.text : t.subtext }]}>
          Passwords match
        </Text>
      </View>
    </View>
  );
}

/**
 * Auth forms (design §3.3, full-screen): sign-in,
 * staged sign-up (name/email → password → birthday), confirm-code, and the
 * password-reset pair (request code → confirm code + new password). On
 * success: setSignedIn → pop the /auth screen → run the stashed gated action.
 * Rendered by app/auth.
 */
export function AuthForms() {
  const t = useTheme();
  const sheetMode = useAuthStore((s) => s.sheetMode);

  // Mode derives from the store's request until the user switches it; every
  // close path runs resetForm(), so each open starts fresh — no reset effect.
  const [modeOverride, setModeOverride] = useState<Mode | null>(null);
  const mode = modeOverride ?? sheetMode;
  const [signUpStep, setSignUpStep] = useState<SignUpStep>(1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Focus lives on the wrapper row so the ring wraps the field AND the eye
  // toggle (the browser's native ring on web only wrapped the inner input).
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [confirmFocused, setConfirmFocused] = useState(false);
  const [dobMonth, setDobMonth] = useState<number | null>(null);
  const [dobDay, setDobDay] = useState<number | null>(null);
  const [dobYear, setDobYear] = useState<number | null>(null);
  const [dobNotice, setDobNotice] = useState<string | null>(null);
  const [activePicker, setActivePicker] = useState<DobPicker | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dobError, setDobError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pickerListRef = useRef<ScrollView>(null);

  function resetForm() {
    setModeOverride(null);
    setSignUpStep(1);
    setName("");
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setShowPassword(false);
    setPasswordFocused(false);
    setConfirmFocused(false);
    setDobMonth(null);
    setDobDay(null);
    setDobYear(null);
    setDobNotice(null);
    setActivePicker(null);
    setCode("");
    setError(null);
    setDobError(null);
    setInfo(null);
    setBusy(false);
  }


  function switchMode(next: Mode) {
    setModeOverride(next);
    setSignUpStep(1);
    setActivePicker(null);
    setError(null);
    setDobError(null);
    setDobNotice(null);
    setInfo(null);
  }

  function completeAuth(signedInEmail: string, signedInName: string, isNewAccount = false) {
    const store = useAuthStore.getState();
    store.setSignedIn(signedInEmail, signedInName);
    resetForm();
    goBack();
    // Close without closeAuth() — that would drop the stashed gated action.
    // A first sign-up hands off to the interest step (design §6.2), which
    // runs the stashed action when it finishes; sign-in resumes immediately.
    if (isNewAccount) {
      useAuthStore.setState({ interestOpen: true });
    } else {
      store.runPendingAction();
    }
  }

  async function submitSignIn() {
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    try {
      const session = await signIn(email, password);
      completeAuth(session.email, session.name);
    } catch (err) {
      if (cognitoErrorCode(err) === "UserNotConfirmedException") {
        try {
          await resendCode(email);
        } catch {
          // resend is best-effort; the confirm screen has its own Resend
        }
        setInfo(`Your account isn't confirmed yet. We sent a new code to ${email.trim()}.`);
        switchModeKeepInfo("confirm");
      } else {
        setError(friendlyError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function switchModeKeepInfo(next: Mode) {
    setModeOverride(next);
    setError(null);
    setDobError(null);
  }

  /* ── staged sign-up ──────────────────────────────────────────────────────── */

  function continueFromStep1() {
    if (!name.trim()) {
      setError("Please tell us your name.");
      return;
    }
    if (!email.trim().includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    setSignUpStep(2);
  }

  function continueFromStep2() {
    if (passwordIssues(password).length > 0 || confirmPassword !== password) return;
    setError(null);
    setSignUpStep(3);
  }

  function goBackStep() {
    setError(null);
    setDobError(null);
    setSignUpStep((s) => (s === 3 ? 2 : 1));
  }

  /**
   * Clamp an already-picked day to the (new) month/year's length. Returns the
   * effective day and tells the user when it moved.
   */
  function clampDayFor(month: number | null, year: number | null, day: number | null): number | null {
    if (day == null) return null;
    const max = daysInMonth(month, year);
    if (day <= max) return day;
    setDobDay(max);
    const monthName = month != null ? (MONTH_NAMES[month - 1] ?? "That month") : "That month";
    setDobNotice(`${monthName}${year != null ? ` ${year}` : ""} has ${max} days. We moved the day to ${max}.`);
    return max;
  }

  /** Advance to the first unset birthday field, or close when all are set. */
  function openNextPicker(month: number | null, day: number | null, year: number | null) {
    if (month == null) setActivePicker("month");
    else if (day == null) setActivePicker("day");
    else if (year == null) setActivePicker("year");
    else setActivePicker(null);
  }

  function pickMonth(month: number) {
    setDobMonth(month);
    setDobError(null);
    setDobNotice(null);
    const day = clampDayFor(month, dobYear, dobDay);
    openNextPicker(month, day, dobYear);
  }

  function pickDay(day: number) {
    setDobDay(day);
    setDobError(null);
    setDobNotice(null);
    openNextPicker(dobMonth, day, dobYear);
  }

  function pickYear(year: number) {
    setDobYear(year);
    setDobError(null);
    setDobNotice(null);
    const day = clampDayFor(dobMonth, year, dobDay);
    openNextPicker(dobMonth, day, year);
  }

  async function submitSignUp() {
    setError(null);
    setDobError(null);
    // Steps 1–2 validated on Continue; these guards are defense in depth and
    // route the user back to the offending step if they somehow trip.
    if (!name.trim()) {
      setError("Please tell us your name.");
      setSignUpStep(1);
      return;
    }
    if (!email.trim().includes("@")) {
      setError("Enter a valid email address.");
      setSignUpStep(1);
      return;
    }
    const issues = passwordIssues(password);
    if (issues.length > 0) {
      setError(`Your password still needs: ${issues.join(", ")}.`);
      setSignUpStep(2);
      return;
    }
    if (confirmPassword !== password) {
      setError("Passwords don't match.");
      setSignUpStep(2);
      return;
    }
    if (dobMonth == null || dobDay == null || dobYear == null) {
      setDobError("Pick your birthday month, day, and year.");
      return;
    }
    const dob = `${dobYear}-${String(dobMonth).padStart(2, "0")}-${String(dobDay).padStart(2, "0")}`;
    // validateDob stays the final guard (real date, not future, 13+).
    const dobCheck = validateDob(dob);
    if (!dobCheck.ok) {
      setDobError(dobCheck.message);
      return;
    }
    setBusy(true);
    try {
      await signUp(email, password, { name: name.trim(), birthdate: dob });
      setInfo(`We sent a 6-digit code to ${email.trim()}.`);
      switchModeKeepInfo("confirm");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitConfirm() {
    setError(null);
    if (code.trim().length !== 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setBusy(true);
    try {
      try {
        await confirmSignUp(email, code);
      } catch (err) {
        // Idempotent confirm: a re-tap (or a retry after the first confirm
        // landed) gets "User cannot be confirmed. Current status is CONFIRMED"
        // — that IS success, never an error to show (seen in the field via HAR).
        const alreadyConfirmed =
          cognitoErrorCode(err) === "NotAuthorizedException" &&
          err instanceof Error &&
          err.message.includes("Current status is CONFIRMED");
        if (!alreadyConfirmed) throw err;
      }
      // The account exists and is confirmed — signup is complete regardless of
      // whether the auto sign-in below still has the password in hand.
      track("auth_signup_complete");
      if (password) {
        const session = await signIn(email, password);
        completeAuth(session.email, session.name, true);
      } else {
        setInfo("You're confirmed. Sign in to continue.");
        switchModeKeepInfo("signIn");
      }
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    setBusy(true);
    try {
      await resendCode(email);
      setInfo(`New code sent to ${email.trim()}.`);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  /* ── password reset ──────────────────────────────────────────────────────── */

  /**
   * Enter (or re-enter) the reset flow. Clears anything typed into the
   * password fields so a sign-in password never leaks into the new-password
   * form, and drops any stale code.
   */
  function openResetRequest() {
    setPassword("");
    setConfirmPassword("");
    setShowPassword(false);
    setPasswordFocused(false);
    setConfirmFocused(false);
    setCode("");
    switchMode("resetRequest");
  }

  /** Leave the reset flow for signIn, keeping the email but nothing typed. */
  function leaveResetFlow() {
    setPassword("");
    setConfirmPassword("");
    setShowPassword(false);
    setCode("");
    switchMode("signIn");
  }

  async function submitResetRequest() {
    setError(null);
    if (!email.trim().includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    try {
      await requestPasswordReset(email);
      // The pools hide whether an email exists, so a
      // reset request "succeeds" either way - the copy must not imply an
      // account was found.
      setInfo(`If there is an account for ${email.trim()}, a 6-digit code is on its way.`);
      switchModeKeepInfo("resetConfirm");
    } catch (err) {
      setError(friendlyResetError(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitResetConfirm() {
    setError(null);
    if (code.trim().length !== 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    // The button is disabled until these pass; defense in depth.
    if (passwordIssues(password).length > 0 || confirmPassword !== password) return;
    setBusy(true);
    try {
      await confirmPasswordReset(email, code, password);
      setPassword("");
      setConfirmPassword("");
      setShowPassword(false);
      setCode("");
      setInfo("Password updated. Sign in with your new password.");
      switchModeKeepInfo("signIn");
    } catch (err) {
      setError(friendlyResetError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Resend the reset code. Throttle errors surface as the friendly wait line. */
  async function resendResetCode() {
    setError(null);
    setBusy(true);
    try {
      await requestPasswordReset(email);
      setInfo(`New code sent to ${email.trim()}.`);
    } catch (err) {
      setError(friendlyResetError(err));
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = [
    styles.input,
    { borderColor: t.line, color: t.text, backgroundColor: t.inset },
  ];

  const pwIssues = passwordIssues(password);
  const passwordsMatch = password.length > 0 && confirmPassword === password;

  // Birthday picker sheet contents for whichever field is open.
  const pickerOptions: { key: string; label: string; selected: boolean; onSelect: () => void }[] =
    [];
  if (activePicker === "month") {
    MONTH_NAMES.forEach((label, i) => {
      pickerOptions.push({
        key: label,
        label,
        selected: dobMonth === i + 1,
        onSelect: () => pickMonth(i + 1),
      });
    });
  } else if (activePicker === "day") {
    const max = daysInMonth(dobMonth, dobYear);
    for (let d = 1; d <= max; d++) {
      pickerOptions.push({
        key: String(d),
        label: String(d),
        selected: dobDay === d,
        onSelect: () => pickDay(d),
      });
    }
  } else if (activePicker === "year") {
    for (const y of YEARS) {
      pickerOptions.push({
        key: String(y),
        label: String(y),
        selected: dobYear === y,
        onSelect: () => pickYear(y),
      });
    }
  }
  const selectedPickerIndex = pickerOptions.findIndex((o) => o.selected);

  return (
    <View style={styles.formWrap}>
      <Text style={[styles.formTitle, { color: t.text }]}>{TITLES[mode]}</Text>
      {info ? <Text style={[styles.info, { color: t.subtext }]}>{info}</Text> : null}

      {mode === "signUp" ? (
        <>
          {signUpStep > 1 ? (
            <View style={styles.stepHeader}>
              <Pressable
                onPress={goBackStep}
                accessibilityRole="button"
                accessibilityLabel="Back"
                disabled={busy}
                hitSlop={8}
                style={styles.backBtn}
              >
                <Ionicons name="chevron-back" size={16} color={t.accent} />
                <Text style={[styles.backLabel, { color: t.accent }]}>Back</Text>
              </Pressable>
            </View>
          ) : null}

          {signUpStep === 1 ? (
            <>
              <TextInput
                style={inputStyle}
                placeholder="Name"
                accessibilityLabel="Name"
                placeholderTextColor={t.subtext}
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                textContentType="name"
                editable={!busy}
              />
              <TextInput
                style={inputStyle}
                placeholder="Email"
                accessibilityLabel="Email"
                placeholderTextColor={t.subtext}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                editable={!busy}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <GoldButton label="Continue" onPress={continueFromStep1} disabled={busy} />
            </>
          ) : null}

          {signUpStep === 2 ? (
            <>
              <View
                style={[
                  styles.passwordRow,
                  { borderColor: passwordFocused ? t.accent : t.line, backgroundColor: t.inset },
                ]}
              >
                <TextInput
                  style={[styles.passwordInput, { color: t.text }]}
                  placeholder="Password"
                  accessibilityLabel="Password"
                  placeholderTextColor={t.subtext}
                  value={password}
                  onChangeText={setPassword}
                  onFocus={() => setPasswordFocused(true)}
                  onBlur={() => setPasswordFocused(false)}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  editable={!busy}
                />
                <Pressable
                  onPress={() => setShowPassword((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                  disabled={busy}
                  hitSlop={8}
                >
                  <Ionicons
                    name={showPassword ? "eye-off" : "eye"}
                    size={20}
                    color={t.subtext}
                  />
                </Pressable>
              </View>
              <View
                style={[
                  styles.passwordRow,
                  { borderColor: confirmFocused ? t.accent : t.line, backgroundColor: t.inset },
                ]}
              >
                <TextInput
                  style={[styles.passwordInput, { color: t.text }]}
                  placeholder="Confirm password"
                  accessibilityLabel="Confirm password"
                  placeholderTextColor={t.subtext}
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  onFocus={() => setConfirmFocused(true)}
                  onBlur={() => setConfirmFocused(false)}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  editable={!busy}
                />
              </View>
              <PasswordChecklist issues={pwIssues} passwordsMatch={passwordsMatch} />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <GoldButton
                label="Continue"
                onPress={continueFromStep2}
                disabled={busy || pwIssues.length > 0 || !passwordsMatch}
              />
            </>
          ) : null}

          {signUpStep === 3 ? (
            <>
              <Text style={[styles.info, { color: t.subtext }]}>
                Your birthday stays private. NILTV is for fans 13 and up.
              </Text>
              <View style={styles.dobRow}>
                <DobField
                  label="Month"
                  value={dobMonth != null ? (MONTH_NAMES[dobMonth - 1] ?? null) : null}
                  onPress={() => setActivePicker("month")}
                  disabled={busy}
                  style={styles.dobMonth}
                />
                <DobField
                  label="Day"
                  value={dobDay != null ? String(dobDay) : null}
                  onPress={() => setActivePicker("day")}
                  disabled={busy}
                />
                <DobField
                  label="Year"
                  value={dobYear != null ? String(dobYear) : null}
                  onPress={() => setActivePicker("year")}
                  disabled={busy}
                />
              </View>
              {dobNotice ? (
                <Text style={[styles.info, { color: t.subtext }]}>{dobNotice}</Text>
              ) : null}
              {dobError ? <Text style={styles.error}>{dobError}</Text> : null}
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <GoldButton label="Sign Up Free" onPress={submitSignUp} busy={busy} />
            </>
          ) : null}

          <Pressable onPress={() => switchMode("signIn")} accessibilityRole="button">
            <Text style={[styles.switch, { color: t.accent }]}>
              Already have an account? Sign in
            </Text>
          </Pressable>

          <Sheet
            visible={activePicker !== null}
            onClose={() => setActivePicker(null)}
            title={activePicker === "month" ? "Month" : activePicker === "day" ? "Day" : "Year"}
          >
            <ScrollView
              ref={pickerListRef}
              style={styles.pickerList}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() => {
                if (selectedPickerIndex > 3) {
                  pickerListRef.current?.scrollTo({
                    y: selectedPickerIndex * OPTION_ROW_HEIGHT - OPTION_ROW_HEIGHT * 2,
                    animated: false,
                  });
                }
              }}
            >
              {pickerOptions.map((opt) => (
                <OptionRow
                  key={opt.key}
                  label={opt.label}
                  selected={opt.selected}
                  onPress={opt.onSelect}
                />
              ))}
            </ScrollView>
          </Sheet>
        </>
      ) : null}

      {mode === "signIn" ? (
        <>
          <TextInput
            style={inputStyle}
            placeholder="Email"
            accessibilityLabel="Email"
            placeholderTextColor={t.subtext}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            editable={!busy}
          />
          <TextInput
            style={inputStyle}
            placeholder="Password"
            accessibilityLabel="Password"
            placeholderTextColor={t.subtext}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
            editable={!busy}
          />
          <Pressable
            onPress={openResetRequest}
            accessibilityRole="button"
            accessibilityLabel="Forgot password?"
            disabled={busy}
          >
            <Text style={[styles.forgot, { color: t.accent }]}>Forgot password?</Text>
          </Pressable>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <GoldButton label="Sign In" onPress={submitSignIn} busy={busy} />
          <Pressable onPress={() => switchMode("signUp")} accessibilityRole="button">
            <Text style={[styles.switch, { color: t.accent }]}>
              New to NILTV? Create an account
            </Text>
          </Pressable>
        </>
      ) : null}

      {mode === "confirm" ? (
        <>
          <TextInput
            style={[...inputStyle, styles.codeInput]}
            placeholder="000000"
            accessibilityLabel="Six digit confirmation code"
            placeholderTextColor={t.subtext}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
            editable={!busy}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <GoldButton label="Confirm" onPress={submitConfirm} busy={busy} />
          <View style={styles.confirmLinks}>
            <Pressable onPress={resend} accessibilityRole="button" disabled={busy}>
              <Text style={[styles.switch, { color: t.accent }]}>Resend code</Text>
            </Pressable>
            <Pressable onPress={() => switchMode("signUp")} accessibilityRole="button">
              <Text style={[styles.switch, { color: t.subtext }]}>Use a different email</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {mode === "resetRequest" ? (
        <>
          <Text style={[styles.info, { color: t.subtext }]}>
            We&apos;ll email you a 6-digit code to reset your password.
          </Text>
          <TextInput
            style={inputStyle}
            placeholder="Email"
            accessibilityLabel="Email"
            placeholderTextColor={t.subtext}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            editable={!busy}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <GoldButton label="Send Code" onPress={submitResetRequest} busy={busy} />
          <Pressable
            onPress={leaveResetFlow}
            accessibilityRole="button"
            accessibilityLabel="Back to sign in"
            disabled={busy}
          >
            <Text style={[styles.switch, { color: t.accent }]}>Back to sign in</Text>
          </Pressable>
        </>
      ) : null}

      {mode === "resetConfirm" ? (
        <>
          <View style={styles.stepHeader}>
            <Pressable
              onPress={openResetRequest}
              accessibilityRole="button"
              accessibilityLabel="Back"
              disabled={busy}
              hitSlop={8}
              style={styles.backBtn}
            >
              <Ionicons name="chevron-back" size={16} color={t.accent} />
              <Text style={[styles.backLabel, { color: t.accent }]}>Back</Text>
            </Pressable>
          </View>
          <TextInput
            style={[...inputStyle, styles.codeInput]}
            placeholder="000000"
            accessibilityLabel="Six digit reset code"
            placeholderTextColor={t.subtext}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
            editable={!busy}
          />
          <View
            style={[
              styles.passwordRow,
              { borderColor: passwordFocused ? t.accent : t.line, backgroundColor: t.inset },
            ]}
          >
            <TextInput
              style={[styles.passwordInput, { color: t.text }]}
              placeholder="New password"
              accessibilityLabel="New password"
              placeholderTextColor={t.subtext}
              value={password}
              onChangeText={setPassword}
              onFocus={() => setPasswordFocused(true)}
              onBlur={() => setPasswordFocused(false)}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
              editable={!busy}
            />
            <Pressable
              onPress={() => setShowPassword((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={showPassword ? "Hide password" : "Show password"}
              disabled={busy}
              hitSlop={8}
            >
              <Ionicons
                name={showPassword ? "eye-off" : "eye"}
                size={20}
                color={t.subtext}
              />
            </Pressable>
          </View>
          <View
            style={[
              styles.passwordRow,
              { borderColor: confirmFocused ? t.accent : t.line, backgroundColor: t.inset },
            ]}
          >
            <TextInput
              style={[styles.passwordInput, { color: t.text }]}
              placeholder="Confirm new password"
              accessibilityLabel="Confirm new password"
              placeholderTextColor={t.subtext}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              onFocus={() => setConfirmFocused(true)}
              onBlur={() => setConfirmFocused(false)}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
              editable={!busy}
            />
          </View>
          <PasswordChecklist issues={pwIssues} passwordsMatch={passwordsMatch} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <GoldButton
            label="Reset Password"
            onPress={submitResetConfirm}
            busy={busy}
            disabled={code.trim().length !== 6 || pwIssues.length > 0 || !passwordsMatch}
          />
          <Pressable
            onPress={resendResetCode}
            accessibilityRole="button"
            accessibilityLabel="Resend code"
            disabled={busy}
          >
            <Text style={[styles.switch, { color: t.accent }]}>Resend code</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  formWrap: {
    gap: 10,
  },
  formTitle: {
    fontFamily: tokens.font.extrabold,
    fontSize: 20,
    marginBottom: 4,
  },
  info: {
    fontFamily: tokens.font.regular,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: tokens.spacing.sm,
  },
  input: {
    borderWidth: 1,
    borderRadius: 9,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: tokens.font.regular,
    fontSize: 15,
    marginBottom: tokens.spacing.md,
  },
  codeInput: {
    fontFamily: tokens.font.bold,
    fontSize: 22,
    letterSpacing: 8,
    textAlign: "center",
  },
  error: {
    color: ERROR_RED,
    fontFamily: tokens.font.semibold,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: tokens.spacing.md,
  },
  switch: {
    fontFamily: tokens.font.bold,
    fontSize: 14,
    textAlign: "center",
    paddingVertical: tokens.spacing.md,
  },
  forgot: {
    fontFamily: tokens.font.bold,
    fontSize: 14,
    textAlign: "right",
    paddingVertical: tokens.spacing.xs,
    marginBottom: tokens.spacing.sm,
  },
  confirmLinks: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  stepHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: tokens.spacing.xs,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minWidth: 56,
    paddingVertical: 4,
  },
  backLabel: {
    fontFamily: tokens.font.bold,
    fontSize: 14,
  },
  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 9,
    paddingRight: 12,
    marginBottom: tokens.spacing.sm,
  },
  passwordInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: tokens.font.regular,
    fontSize: 15,
    // The wrapper row carries the focus ring; without this the web build adds
    // the browser's own outline around just the input, stopping at the eye.
    outlineWidth: 0,
  },
  checkList: {
    marginBottom: tokens.spacing.md,
    gap: 6,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  checkLabel: {
    fontFamily: tokens.font.regular,
    fontSize: 13,
  },
  dobRow: {
    flexDirection: "row",
    gap: tokens.spacing.sm,
    marginBottom: tokens.spacing.md,
  },
  dobField: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 9,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  dobMonth: {
    flex: 1.4,
  },
  dobFieldLabel: {
    fontFamily: tokens.font.regular,
    fontSize: 11,
    marginBottom: 2,
  },
  dobFieldValue: {
    fontFamily: tokens.font.semibold,
    fontSize: 15,
  },
  pickerList: {
    maxHeight: 360,
  },
  optionRow: {
    height: OPTION_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: tokens.spacing.sm,
  },
  optionLabel: {
    fontSize: 15,
  },
});
