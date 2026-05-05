const mongoose = require("mongoose");
const User = require("./modules/user/user.model");
require("dotenv").config();

async function test() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // create a dummy google user
    const dummyProfile = {
      name: "Test User",
      email: "test_google_user_" + Date.now() + "@gmail.com",
      id: "dummy_google_id_" + Date.now()
    };

    let user = await User.create({
      name: dummyProfile.name,
      email: dummyProfile.email,
      googleId: dummyProfile.id,
      authProvider: "google",
    });

    console.log("User created successfully:", user);

    // cleanup
    await User.deleteOne({ _id: user._id });
    console.log("User cleaned up.");

  } catch (error) {
    console.error("Error creating user:", error);
  } finally {
    await mongoose.disconnect();
  }
}

test();
