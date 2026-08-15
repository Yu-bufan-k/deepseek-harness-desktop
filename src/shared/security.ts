const SENSITIVE_KEY =
  /(api[-_]?key|token|secret|password|authorization|cookie)/i;

export function redactSensitive(input: string): string {
  return input
    .replace(/(bearer\s+)[a-z0-9._~+/]+=*/gi, "$1[REDACTED]")
    .replace(
      /((?:api[-_]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

export function sanitizedEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !SENSITIVE_KEY.test(key)),
  );
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}
