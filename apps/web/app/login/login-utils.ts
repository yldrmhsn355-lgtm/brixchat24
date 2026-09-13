export type LoginFieldErrors = Partial<Record<"email" | "password", string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLoginFields(
  email: string,
  password: string,
): LoginFieldErrors {
  const errors: LoginFieldErrors = {};
  if (!email.trim()) errors.email = "E-posta adresinizi girin.";
  else if (!EMAIL_PATTERN.test(email.trim()))
    errors.email = "Geçerli bir e-posta adresi girin.";
  if (!password) errors.password = "Parolanızı girin.";
  return errors;
}

export function loginErrorMessage(status: number, code?: string) {
  if (status === 401 || code === "invalid_credentials")
    return "E-posta veya parola hatalı. Bilgilerinizi kontrol edip tekrar deneyin.";
  if (status === 429)
    return "Çok fazla giriş denemesi yapıldı. Lütfen bir süre bekleyip tekrar deneyin.";
  if (status >= 500)
    return "Giriş hizmetine şu anda ulaşılamıyor. Lütfen kısa süre sonra tekrar deneyin.";
  return "Giriş tamamlanamadı. Bilgilerinizi kontrol edip tekrar deneyin.";
}

export const networkLoginErrorMessage =
  "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.";
