// AES-256-GCM for stored calendar links: "v1:<iv>:<tag>:<ciphertext>",
// each part base64. The key is the OUTLOOK_FEED_KEY secret.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptUrl(url, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptUrl(enc, key) {
    const [v, iv, tag, ct] = String(enc).split(':');
    if (v !== 'v1') throw new Error('Unknown link format');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
