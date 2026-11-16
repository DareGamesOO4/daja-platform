import { timingSafeEqual } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import nodemailer from 'nodemailer';

initializeApp();

const smtpUser = defineSecret('DAJA_SMTP_USER');
const smtpPassword = defineSecret('DAJA_SMTP_PASSWORD');
const requestSecret = defineSecret('DAJA_EMAIL_REQUEST_SECRET');
const sender = /^(?:(?:nalog|porudzbine)@dajashop\.rs|DajaShop <(?:nalog|porudzbine)@dajashop\.rs>)$/i;
const address = /^[^\s<>,@;:"()\\]+@[^\s<>,@;:"()\\]+\.[^\s<>,@;:"()\\]+$/;

export const sendDajaEmail = onRequest({
  region: 'europe-west1',
  timeoutSeconds: 60,
  invoker: 'public',
  secrets: [smtpUser, smtpPassword, requestSecret]
}, async (req, res) => {
  if (req.method !== 'POST') {
    res.sendStatus(405);
    return;
  }
  const provided = Buffer.from(req.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${requestSecret.value()}`);
  if (!requestSecret.value() || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    res.sendStatus(401);
    return;
  }

  const { id, from, to, subject, text, html, replyTo } = req.body ?? {};
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) ||
      typeof from !== 'string' || !sender.test(from) ||
      typeof to !== 'string' || !address.test(to) ||
      typeof subject !== 'string' || /[\r\n]/.test(subject) ||
      typeof text !== 'string' || typeof html !== 'string' ||
      (replyTo !== undefined && !(Array.isArray(replyTo) ? replyTo : [replyTo])
        .every(value => typeof value === 'string' && address.test(value)))) {
    res.sendStatus(400);
    return;
  }

  const delivery = getFirestore().collection('dajaEmailReceipts').doc(id);
  try {
    await delivery.create({
      status: 'sending',
      expiresAt: Timestamp.fromMillis(Date.now() + 45 * 24 * 60 * 60 * 1000)
    });
  } catch (error) {
    if (error.code !== 6) throw error;
    // A request timeout cannot safely reopen a delivery whose SMTP outcome is unknown.
    const receipt = (await delivery.get()).data();
    if (receipt?.acceptedAt) res.set('X-Daja-Accepted-At', receipt.acceptedAt.toDate().toISOString());
    res.sendStatus(receipt?.status === 'accepted' ? 204 : 409);
    return;
  }

  const smtp = nodemailer.createTransport({
    host: 'smtp.mail.me.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: smtpUser.value(), pass: smtpPassword.value() },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 25_000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
  try {
    await smtp.sendMail({
      from, to, subject, text, html, replyTo,
      messageId: `<${id}@dajashop.rs>`,
      dsn: { id, return: 'headers', notify: ['success', 'failure', 'delay'], recipient: to }
    });
  } catch (error) {
    if (error.responseCode >= 400 && error.responseCode < 600) await delivery.delete();
    console.warn('iCloud SMTP did not confirm acceptance', { id, code: error.code });
    res.sendStatus(502);
    return;
  }
  const acceptedAt = Timestamp.now();
  await delivery.update({ status: 'accepted', acceptedAt });
  res.set('X-Daja-Accepted-At', acceptedAt.toDate().toISOString());
  res.sendStatus(204);
});
