const { extractProfileData } = require("../../services/gemini.service");
const { uploadToS3, deleteFromS3, getPresignedUrl } = require("../../services/s3.service");
const User = require("./user.model");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const bcrypt = require("bcryptjs");

// ─── GET /api/user/me ────────────────────────────────────────────────────────
// Returns the full user profile (structured for the frontend)
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const photoUrl = user.photoS3Key ? await getPresignedUrl(user.photoS3Key) : user.photoUrl || "";
    const resumeUrl = user.resumeS3Key ? await getPresignedUrl(user.resumeS3Key) : user.resumeUrl || null;

    // Shape the response to match frontend expectations
    res.json({
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        authProvider: user.authProvider,
        photo: photoUrl,
      },
      basicInfo: {
        name:         user.name || "",
        countryCode:  user.countryCode || "+91",
        mobileNumber: user.mobileNumber || "",
        email:        user.email,
        role:         user.role || "",
        photo:        photoUrl,
      },
      profileData: {
        about:          user.about || "",
        skills:         user.skills || [],
        education:      user.education || [],
        projects:       user.projects || [],
        experience:     user.experience || [],
        certifications: user.certifications || [],
        codingProfiles: user.codingProfiles || { github: "", leetcode: "", codechef: "" },
        achievements:   user.achievements || "",
        connectedMails: user.connectedMails || [],
      },
      resumeUrl: resumeUrl,
    });
  } catch (err) {
    console.error("getProfile error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── PUT /api/user/basic ─────────────────────────────────────────────────────
// Update basic info (name, countryCode, mobileNumber, email, role)
exports.updateBasicInfo = async (req, res) => {
  try {
    const { name, countryCode, mobileNumber, email, role } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (name !== undefined) {
      user.name = name;
      user.firstName = name.split(" ")[0] || "";
      user.lastName = name.split(" ").slice(1).join(" ") || "";
    }
    if (countryCode !== undefined)  user.countryCode = countryCode;
    if (mobileNumber !== undefined) user.mobileNumber = mobileNumber;
    if (role !== undefined)         user.role = role;

    // Email change (only if different and not taken)
    if (email && email !== user.email) {
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) {
        return res.status(400).json({ message: "Email already in use" });
      }
      user.email = email.toLowerCase();
    }

    await user.save();
    res.json({ message: "Basic info updated", user });
  } catch (err) {
    console.error("updateBasicInfo error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── PUT /api/user/profile ───────────────────────────────────────────────────
// Update all profile data sections at once
exports.updateProfileData = async (req, res) => {
  try {
    const {
      about, skills, education, projects,
      experience, certifications, codingProfiles,
      achievements, connectedMails
    } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (about !== undefined)          user.about = about;
    if (skills !== undefined)         user.skills = skills;
    if (education !== undefined)      user.education = education;
    if (projects !== undefined)       user.projects = projects;
    if (experience !== undefined)     user.experience = experience;
    if (certifications !== undefined) user.certifications = certifications;
    if (achievements !== undefined)   user.achievements = achievements;
    if (connectedMails !== undefined) user.connectedMails = connectedMails;

    if (codingProfiles !== undefined) {
      user.codingProfiles = {
        github:   codingProfiles.github   || user.codingProfiles.github,
        leetcode: codingProfiles.leetcode || user.codingProfiles.leetcode,
        codechef: codingProfiles.codechef || user.codingProfiles.codechef,
      };
    }

    await user.save();
    res.json({ message: "Profile updated", user });
  } catch (err) {
    console.error("updateProfileData error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── PUT /api/user/section/:section ──────────────────────────────────────────
// Update a single profile section (skills, education, experience, etc.)
exports.updateSection = async (req, res) => {
  try {
    const { section } = req.params;
    const { data } = req.body;

    const allowedSections = [
      "about", "skills", "education", "projects",
      "experience", "certifications", "codingProfiles",
      "achievements", "connectedMails"
    ];

    if (!allowedSections.includes(section)) {
      return res.status(400).json({ message: `Invalid section: ${section}` });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user[section] = data;
    await user.save();

    res.json({ message: `${section} updated`, [section]: user[section] });
  } catch (err) {
    console.error("updateSection error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── POST /api/user/upload-photo ─────────────────────────────────────────────
// Upload profile photo to S3
exports.uploadPhoto = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please upload an image file." });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Delete old photo from S3 if exists
    if (user.photoS3Key) {
      try {
        await deleteFromS3(user.photoS3Key);
      } catch (e) {
        console.warn("Failed to delete old photo from S3:", e.message);
      }
    }

    // Upload new photo
    const { url, key } = await uploadToS3(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      req.user._id.toString(),
      "photos" // folder prefix
    );

    user.photoUrl = url;
    user.photoS3Key = key;
    await user.save();

    const presignedUrl = await getPresignedUrl(key);
    res.json({ message: "Photo uploaded", photoUrl: presignedUrl });
  } catch (err) {
    console.error("uploadPhoto error:", err);
    res.status(500).json({ message: "Server error during photo upload" });
  }
};

// ─── POST /api/user/upload-resume ────────────────────────────────────────────
// Upload resume to S3, extract text, parse skills, optionally fill profile
exports.uploadResume = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please upload a PDF or DOCX file." });
    }

    const fileBuffer = req.file.buffer;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Delete old resume from S3 if exists
    if (user.resumeS3Key) {
      try {
        await deleteFromS3(user.resumeS3Key);
      } catch (e) {
        console.warn("Failed to delete old resume from S3:", e.message);
      }
    }

    // Extract text from resume
    let extractedText;
    if (req.file.mimetype === "application/pdf") {
      const parsed = await pdfParse(fileBuffer);
      extractedText = parsed.text;
    } else {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      extractedText = result.value;
    }

    // Extract full profile data via Gemini AI
    let extractedData = {};
    try {
      extractedData = await extractProfileData(extractedText);
    } catch (e) {
      console.warn("Gemini extraction failed, using fallback:", e.message);
      // Fallback: basic keyword matching for skills and role
      const possibleSkills = [
        "React", "JavaScript", "Node.js", "Express", "MongoDB", "Python",
        "Java", "C++", "SQL", "Git", "Docker", "AWS", "TypeScript",
        "HTML", "CSS", "Figma", "Tailwind", "Next.js", "GraphQL",
        "Redis", "PostgreSQL", "Firebase", "Flutter", "Kotlin", "Swift"
      ];
      const textLC = extractedText.toLowerCase();
      extractedData.skills = possibleSkills.filter(s => textLC.includes(s.toLowerCase()));
      
      let fallbackRole = "";
      if (textLC.includes("frontend") || textLC.includes("react")) fallbackRole = "Frontend Developer";
      else if (textLC.includes("backend") || textLC.includes("node")) fallbackRole = "Backend Developer";
      else if (textLC.includes("full stack") || textLC.includes("fullstack")) fallbackRole = "Full Stack Developer";
      else if (textLC.includes("data") || textLC.includes("machine learning")) fallbackRole = "Data Scientist";
      extractedData.role = fallbackRole;
    }

    // Upload to S3
    const { url, key } = await uploadToS3(
      fileBuffer,
      req.file.originalname,
      req.file.mimetype,
      req.user._id.toString()
    );

    // Save S3 details to user profile
    user.resumeUrl = url;
    user.resumeS3Key = key;
    user.extractedSkills = extractedData.skills || [];

    // Merge extracted data into profile (if present and user hasn't filled them out heavily)
    if (extractedData.skills && Array.isArray(extractedData.skills)) {
      user.skills = [...new Set([...user.skills, ...extractedData.skills])];
    }
    if (extractedData.role && !user.role) {
      user.role = extractedData.role;
    }
    if (extractedData.about && !user.about) {
      user.about = extractedData.about;
    }
    if (extractedData.achievements && !user.achievements) {
      user.achievements = extractedData.achievements;
    }
    if (extractedData.experience && Array.isArray(extractedData.experience) && extractedData.experience.length > 0) {
      // Append unique items (simplistic logic) or just append all
      user.experience = [...user.experience, ...extractedData.experience];
    }
    if (extractedData.education && Array.isArray(extractedData.education) && extractedData.education.length > 0) {
      user.education = [...user.education, ...extractedData.education];
    }
    if (extractedData.projects && Array.isArray(extractedData.projects) && extractedData.projects.length > 0) {
      user.projects = [...user.projects, ...extractedData.projects];
    }
    if (extractedData.certifications && Array.isArray(extractedData.certifications) && extractedData.certifications.length > 0) {
      user.certifications = [...user.certifications, ...extractedData.certifications];
    }

    await user.save();

    const presignedUrl = await getPresignedUrl(key);

    res.json({
      message: "Resume processed and uploaded",
      resumeUrl: presignedUrl,
      profileData: {
        about: user.about,
        skills: user.skills,
        education: user.education,
        experience: user.experience,
        projects: user.projects,
        certifications: user.certifications,
        achievements: user.achievements,
      },
      basicInfo: {
        role: user.role,
      }
    });
  } catch (error) {
    console.error("Resume upload error:", error);
    res.status(500).json({ message: "Server error during file processing" });
  }
};

// ─── PUT /api/user/change-password ───────────────────────────────────────────
// Change password (requires current password)
exports.changePassword = async (req, res) => {
  try {
    const { current, new: newPwd, confirm } = req.body;

    if (!current || !newPwd || !confirm) {
      return res.status(400).json({ message: "All password fields are required" });
    }

    if (newPwd !== confirm) {
      return res.status(400).json({ message: "New passwords do not match" });
    }

    if (newPwd.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const user = await User.findById(req.user._id).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.authProvider !== "local") {
      return res.status(400).json({
        message: `Password change is not available for ${user.authProvider} accounts`
      });
    }

    const isMatch = await bcrypt.compare(current, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    user.password = await bcrypt.hash(newPwd, 10);
    await user.save();

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("changePassword error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─── Legacy: UPDATE profile (mobile + preferences) ──────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const { mobileNumber, countryCode, reminderPreferences } = req.body;
    const user = await User.findById(req.user._id);

    if (mobileNumber) user.mobileNumber = mobileNumber;
    if (countryCode) user.countryCode = countryCode;
    if (reminderPreferences) user.reminderPreferences = reminderPreferences;

    await user.save();
    res.json({ message: "Profile updated", user });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};