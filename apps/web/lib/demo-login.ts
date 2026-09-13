export type DemoLogin = {
  email: string;
  password: string;
};

export function resolveDemoLogin(
  environment: string | undefined,
  emailValue: string | undefined,
  passwordValue: string | undefined,
): DemoLogin | null {
  if (environment !== "development") return null;

  const email = emailValue?.trim();
  if (!email || !passwordValue) return null;

  return { email, password: passwordValue };
}
