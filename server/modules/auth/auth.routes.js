const express = require("express");
const router = express.Router();
const controller = require("./auth.controller");

// Signup flow: send-signup-otp → signup
router.post("/send-signup-otp", controller.sendSignupOtp);
router.post("/signup", controller.signup);
router.post("/login", controller.login);

// Password flow: forgot-password (email link sent) → reset-password / change-password
router.post("/forgot-password", controller.forgotPassword);
router.post("/reset-password", controller.resetPassword);   // no old password needed
router.post("/change-password", controller.changePassword); // old password required

module.exports = router;