/**
 * Job Proxy — Forwards job-related requests to the SerpAPI microservice.
 *
 * Future Scope: Add a GET /recommendations proxy that accepts the user's
 * extracted resume skills (User.extractedSkills[]) and role (User.role)
 * to return personalized job recommendations ranked by skill overlap.
 * The SerpAPI microservice already stores jobs with `role` and `snippet`
 * fields, making skill-based matching straightforward.
 */

const express = require("express");
const axios = require("axios");
const logger = require("../../utils/logger");

const router = express.Router();
// JOBS_SERVICE_URL lets a multi-VM deployment point the proxy at the serpapi
// service over the private network (e.g. http://<VM3_IP>:5001/api/jobs).
// Falls back to the previous behaviour when the env var is not set.
const MICROSERVICE_URL =
  process.env.JOBS_SERVICE_URL ||
  (process.env.NODE_ENV === "production"
    ? "https://jobs.mail-or-a.dev/api/jobs"
    : "http://localhost:5001/api/jobs");

// Proxy GET /search
router.get("/search", async (req, res) => {
  try {
    const response = await axios.get(`${MICROSERVICE_URL}/search`, {
      params: req.query,
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    logger.error("JobProxy", "Error forwarding search request", error);
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ success: false, message: "Microservice unavailable" });
    }
  }
});

// Proxy GET /roles
router.get("/roles", async (req, res) => {
  try {
    const response = await axios.get(`${MICROSERVICE_URL}/roles`);
    res.status(response.status).json(response.data);
  } catch (error) {
    logger.error("JobProxy", "Error forwarding roles request", error);
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ success: false, message: "Microservice unavailable" });
    }
  }
});

// Proxy POST /refresh
router.post("/refresh", async (req, res) => {
  try {
    const response = await axios.post(`${MICROSERVICE_URL}/refresh`, null, {
      headers: process.env.JOBS_API_KEY ? { "x-api-key": process.env.JOBS_API_KEY } : {},
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    logger.error("JobProxy", "Error forwarding refresh request", error);
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ success: false, message: "Microservice unavailable" });
    }
  }
});

module.exports = router;
