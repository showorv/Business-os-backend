import nodemailer from "nodemailer";
import { env } from "../app/config/env.config.js";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

// One small adapter, so changing email provider touches only this file.
const transport = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;

export const emailEnabled = () => transport !== null;

export const sendEmail = async (email: OutgoingEmail) => {
  if (!transport) throw new Error("email is not configured");
  await transport.sendMail({ from: env.EMAIL_FROM, ...email });
};
