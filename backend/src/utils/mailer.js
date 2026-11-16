const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendResetEmail(to, link) {
  // no SMTP configured: print the link in the server console (good for local demo)
  if (!process.env.SMTP_HOST) {
    console.log(`[DEV] Password reset link for ${to}: ${link}`);
    return;
  }
  await getTransporter().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: 'Reset your EduGen password',
    text: `Use this link to reset your password (valid for 15 minutes): ${link}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Use this link to reset your password (valid for 15 minutes):</p><p><a href="${link}">${link}</a></p><p>If you did not request this, ignore this email.</p>`,
  });
}

module.exports = { sendResetEmail };