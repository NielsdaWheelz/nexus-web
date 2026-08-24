// The one closed set of terminal upload-verification rejections. Confirmation
// records exactly these codes on a session, the Activity projection replays
// them, and both web decoders narrow to this union so a server that adds a
// fourth code fails the strict decode instead of rendering the wrong reason.

export const UPLOAD_VERIFICATION_CODES = [
  "E_SOURCE_INTEGRITY",
  "E_INVALID_FILE_TYPE",
  "E_FILE_TOO_LARGE",
] as const;

export type UploadVerificationCode = (typeof UPLOAD_VERIFICATION_CODES)[number];
