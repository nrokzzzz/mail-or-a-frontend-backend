const RegistrationEmail = require("./registration.model");
const RegisteredEmail   = require("./registered.model");
const InProgressEmail   = require("./inprogress.model");
const ConfirmedEmail    = require("./confirmed.model");
const { decrypt }       = require("../../utils/crypto");

const MODELS = [
  { model: RegistrationEmail, type: "registration" },
  { model: RegisteredEmail,   type: "registered"   },
  { model: InProgressEmail,   type: "inprogress"   },
  { model: ConfirmedEmail,    type: "confirmed"     },
];

function decryptEmail(email, type) {
  return {
    ...email._doc,
    type,
    subject: decrypt(email.subject),
    from:    decrypt(email.from),
    snippet: decrypt(email.snippet),
    body:    decrypt(email.body),
  };
}

// GET /api/emails — all emails for the user across all categories
exports.getAllEmails = async (req, res) => {
  try {
    const results = await Promise.all(
      MODELS.map(({ model, type }) =>
        model
          .find({ userId: req.user._id })
          .sort({ receivedAt: -1 })
          .then((docs) => docs.map((doc) => decryptEmail(doc, type)))
      )
    );

    const all = results
      .flat()
      .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

    res.json(all);
  } catch (err) {
    console.error("Error fetching emails:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/emails/registration
exports.getRegistrationEmails = async (req, res) => {
  try {
    const emails = await RegistrationEmail.find({ userId: req.user._id }).sort({ receivedAt: -1 });
    res.json(emails.map((e) => decryptEmail(e, "registration")));
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/emails/registered
exports.getRegisteredEmails = async (req, res) => {
  try {
    const emails = await RegisteredEmail.find({ userId: req.user._id }).sort({ receivedAt: -1 });
    res.json(emails.map((e) => decryptEmail(e, "registered")));
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/emails/inprogress
exports.getInProgressEmails = async (req, res) => {
  try {
    const emails = await InProgressEmail.find({ userId: req.user._id }).sort({ receivedAt: -1 });
    res.json(emails.map((e) => decryptEmail(e, "inprogress")));
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/emails/confirmed
exports.getConfirmedEmails = async (req, res) => {
  try {
    const emails = await ConfirmedEmail.find({ userId: req.user._id }).sort({ receivedAt: -1 });
    res.json(emails.map((e) => decryptEmail(e, "confirmed")));
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
