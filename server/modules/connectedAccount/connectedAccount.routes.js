const express = require("express");
const router = express.Router();
const controller = require("./connectedAccount.controller");
const syncController = require("./sync.controller");
const { protect } = require("../../middlewares/auth.middleware");

router.get("/", protect, controller.getAccounts);
router.delete("/:id", protect, controller.disconnectAccount);
router.post("/:id/sync", protect, syncController.syncAccount);

module.exports = router;