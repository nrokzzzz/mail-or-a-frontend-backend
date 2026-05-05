const express = require("express");
const axios = require("axios");

const router = express.Router();
const MICROSERVICE_URL = "http://localhost:5001/api/jobs"; // Internal address to microservice

// Proxy GET /search
router.get("/search", async (req, res) => {
  try {
    const response = await axios.get(`${MICROSERVICE_URL}/search`, {
      params: req.query,
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error("[Job Proxy] Error forwarding search request:", error.message);
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
    console.error("[Job Proxy] Error forwarding roles request:", error.message);
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
    const response = await axios.post(`${MICROSERVICE_URL}/refresh`);
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error("[Job Proxy] Error forwarding refresh request:", error.message);
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ success: false, message: "Microservice unavailable" });
    }
  }
});

module.exports = router;
