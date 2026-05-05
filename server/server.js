require("dotenv").config();
const app = require("./app");
const connectDB = require("./config/db");
const { startReminderScheduler } = require("./services/reminderScheduler.service");

connectDB();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Start the WhatsApp reminder cron (checks every 5 minutes)
  startReminderScheduler();
});