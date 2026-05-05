const express = require("express");
// const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");

const app = express();

app.use(helmet());
app.use(morgan("dev"));
app.use(cookieParser());
app.use(express.json());
app.use(
  require("cors")({
    origin: ["https://mail-or-a.dev", "http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173", "http://127.0.0.1:5174"],
    credentials: true,
  })
);
app.get('/', (req, res) => {
  res.send("Hello NaGu");
})
app.use("/api/auth", require("./modules/auth/auth.routes"));
app.use("/api/auth", require("./modules/auth/socialAuth.routes")); // Google + Microsoft sign-in
app.use("/api/user", require("./modules/user/user.routes"));
app.use("/api/accounts", require("./modules/connectedAccount/connectedAccount.routes"));
app.use("/api/emails", require("./modules/email/email.routes"));
app.use("/webhook", require("./webhooks/gmail.webhook"));
app.use("/api", require("./modules/auth/google.routes")); // Gmail account connection (existing)
module.exports = app;