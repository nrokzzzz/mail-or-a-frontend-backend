const express = require("express");
const router = express.Router();
const controller = require("./auth.controller");
const rateLimit = require("express-rate-limit");

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3, // limit each IP to 3 requests per windowMs
  message: { message: "Too many OTP requests from this IP, please try again after 10 minutes" }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 login requests per windowMs
  message: { message: "Too many login attempts from this IP, please try again after 15 minutes" }
});

// Signup flow: send-signup-otp → signup
router.post("/send-signup-otp", otpLimiter, controller.sendSignupOtp);
router.post("/signup", controller.signup);
router.post("/login", loginLimiter, controller.login);
router.post("/logout", controller.logout);

// Password flow: forgot-password (email link sent) → reset-password / change-password
router.post("/forgot-password", otpLimiter, controller.forgotPassword);
router.post("/reset-password", controller.resetPassword);   // no old password needed
router.post("/change-password", controller.changePassword); // old password required

module.exports = router;