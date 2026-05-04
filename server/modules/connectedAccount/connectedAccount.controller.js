const ConnectedAccount = require("./connectedAccount.model");

// Get all connected accounts for user
exports.getAccounts = async (req, res) => {
  try {
    const accounts = await ConnectedAccount.find({
      userId: req.user._id,
    }).select("-accessToken -refreshToken");

    res.json(accounts);
  } catch (err) {
    console.error("Error fetching accounts:", err);
    res.status(500).json({ message: "Server error" });
  }
};