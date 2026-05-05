const express = require("express");
const router = express.Router();
const controller = require("./user.controller");
const { protect } = require("../../middlewares/auth.middleware");
const upload = require("../../middlewares/upload.middleware");
const { photoUpload } = require("../../middlewares/upload.middleware");

// ── Profile ──
router.get("/me",                  protect, controller.getProfile);
router.put("/basic",               protect, controller.updateBasicInfo);
router.put("/profile",             protect, controller.updateProfileData);
router.put("/section/:section",    protect, controller.updateSection);
router.put("/change-password",     protect, controller.changePassword);

// ── Mobile Verification (WhatsApp OTP) ──
router.post("/send-mobile-otp",    protect, controller.sendMobileOtp);
router.post("/verify-mobile-otp",  protect, controller.verifyMobileOtp);

// ── File Uploads (S3) ──
router.post("/upload-photo",       protect, photoUpload.single("photo"),  controller.uploadPhoto);
router.post("/upload-resume",      protect, upload.single("file"),        controller.uploadResume);

// ── Legacy ──
router.put("/update",              protect, controller.updateProfile);

module.exports = router;