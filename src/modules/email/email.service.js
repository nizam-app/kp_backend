import { Resend } from "resend";
import { env } from "../../config/env.js";

const GENERIC_PASSWORD_RESET_MESSAGE =
  "If an account exists for this email, password reset instructions have been sent.";

export const isEmailConfigured = () =>
  Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);

let resendClient = null;

const getResend = () => {
  if (!isEmailConfigured()) return null;
  if (!resendClient) {
    resendClient = new Resend(env.RESEND_API_KEY);
  }
  return resendClient;
};

/** Web / deep-link URL where the client reads `token` and calls POST /auth/reset-password */
export const buildPasswordResetUrl = (resetToken) => {
  const base = (env.PASSWORD_RESET_URL || env.APP_PUBLIC_URL || "").trim().replace(
    /\/$/,
    ""
  );
  if (!base) return null;

  const path = base.includes("/reset-password") ? base : `${base}/reset-password`;
  if (path.startsWith("http://") || path.startsWith("https://")) {
    const url = new URL(path);
    url.searchParams.set("token", resetToken);
    return url.toString();
  }
  return `${path}?token=${encodeURIComponent(resetToken)}`;
};

export const sendPasswordResetEmail = async ({ to, resetToken }) => {
  const resend = getResend();
  if (!resend) {
    throw new Error("Email is not configured (RESEND_API_KEY and EMAIL_FROM required)");
  }

  const resetUrl = buildPasswordResetUrl(resetToken);
  const linkBlock = resetUrl
    ? `<p><a href="${resetUrl}">Reset your password</a></p><p style="color:#666;font-size:12px;">Or copy this link:<br/>${resetUrl}</p>`
    : `<p>Use this reset code in the app (valid 10 minutes):</p><p style="font-family:monospace;font-size:16px;">${resetToken}</p>`;

  const textBody = resetUrl
    ? `Reset your TruckFix password: ${resetUrl}\n\nThis link expires in 10 minutes.`
    : `Your TruckFix password reset code: ${resetToken}\n\nEnter it in the app. Expires in 10 minutes.`;

  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to: [to],
    subject: "Reset your TruckFix password",
    text: textBody,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:480px;">
        <h2>Reset your password</h2>
        <p>We received a request to reset the password for your TruckFix account.</p>
        ${linkBlock}
        <p>If you did not request this, you can ignore this email. The link expires in 10 minutes.</p>
        <p style="margin-top:24px;color:#999;font-size:12px;">TruckFix</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(error.message || "Resend send failed");
  }
};

export { GENERIC_PASSWORD_RESET_MESSAGE };
