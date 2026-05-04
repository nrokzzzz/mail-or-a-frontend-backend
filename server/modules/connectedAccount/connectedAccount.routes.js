const express = require("express");
const router = express.Router();
const controller = require("./connectedAccount.controller");
const { protect } = require("../../middlewares/auth.middleware");

router.get("/", protect, controller.getAccounts);

module.exports = router;