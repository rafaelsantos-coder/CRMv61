const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;

/**
 * Faz upload de um arquivo para o R2.
 * @param {Buffer} buffer - Conteúdo do arquivo
 * @param {string} originalName - Nome original do arquivo
 * @param {string} folder - Pasta no bucket (ex: 'credito', 'contratos')
 * @param {string} mimeType - MIME type do arquivo
 * @returns {Promise<{key: string, url: string}>}
 */
async function uploadFile(buffer, originalName, folder, mimeType) {
  const ext = path.extname(originalName).toLowerCase();
  const key = `${folder}/${uuidv4()}${ext}`;

  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    Metadata: {
      originalName,
      uploadedAt: new Date().toISOString(),
    },
  }));

  return { key };
}

/**
 * Gera uma URL assinada para download temporário (15 minutos).
 */
async function getSignedDownloadUrl(key, expiresInSeconds = 900) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(r2, command, { expiresIn: expiresInSeconds });
}

/**
 * Deleta um arquivo do R2.
 */
async function deleteFile(key) {
  await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { uploadFile, getSignedDownloadUrl, deleteFile };
