const multer = require("multer");

// Use memory storage — file is held in req.file.buffer (never written to disk)
// This buffer is sent directly to S3
const storage = multer.memoryStorage();

// Resume upload — PDF and DOCX only, 5MB max
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and DOCX allowed"), false);
    }
  },
});

// Photo upload — images only, 3MB max
const photoUpload = multer({
  storage,
  limits: {
    fileSize: 3 * 1024 * 1024, // 3 MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, WebP, and GIF images allowed"), false);
    }
  },
});

module.exports = upload;
module.exports.photoUpload = photoUpload;