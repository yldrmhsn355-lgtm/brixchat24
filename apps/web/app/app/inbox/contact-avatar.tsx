import type { CSSProperties } from "react";

function safeProfilePictureUrl(value: string | null) {
  if (!value) return null;
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function contactAvatarStyle(
  profilePictureUrl: string | null,
): CSSProperties {
  const safeUrl = safeProfilePictureUrl(profilePictureUrl);
  return safeUrl
    ? {
        backgroundImage: `url(${JSON.stringify(safeUrl)})`,
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        backgroundSize: "cover",
      }
    : {};
}

export function ContactAvatar({
  contactName,
  initials,
  profilePictureUrl,
  size,
}: {
  contactName: string;
  initials: string;
  profilePictureUrl: string | null;
  size?: "large";
}) {
  const hasPicture = Boolean(safeProfilePictureUrl(profilePictureUrl));
  return (
    <span
      className={`avatar${size ? ` ${size}` : ""}`}
      style={contactAvatarStyle(profilePictureUrl)}
      role="img"
      aria-label={`${contactName} profil görseli`}
    >
      {hasPicture ? <i /> : initials}
    </span>
  );
}
