# Mailora 2.0: Kafka Architecture & Working Nature

This document details the complete end-to-end working nature of Apache Kafka within the Mailora 2.0 system. It is structured to help you articulate the design decisions, trade-offs, and implementation details during technical interviews, particularly for Amazon SDE-1/SDE-2 roles.

---

## 1. Why Kafka? The Problem It Solves

In the initial design or synchronous approach, when a Gmail Webhook arrived, the server would immediately process the email, call the Gemini AI API for classification, and then save the result to MongoDB. 

**Problems with Synchronous Approach:**
*   **Timeouts & Latency:** Gemini AI processing takes time (several seconds). If multiple emails arrived simultaneously, the webhook response would timeout, causing Gmail to retry or drop the payload.
*   **Coupling:** The ingestion system (Webhook) was tightly coupled with the processing engine (AI).
*   **Spike Handling:** If a user synced 500 emails at once, the server would be overwhelmed with synchronous API calls to Gemini, hitting rate limits and crashing the Node.js event loop.
*   **Fault Tolerance:** If the AI processing failed, the email data was lost unless a complex custom retry mechanism was built into the HTTP layer.

**The Kafka Solution:**
*   **Asynchronous Processing:** Webhooks instantly acknowledge receipt to Gmail (HTTP 200) and dump the payload into a Kafka topic. Processing happens in the background.
*   **Decoupling:** Ingestion, Processing, and Notification are now completely separate microservices/workers.
*   **Load Leveling (Buffering):** Kafka acts as a buffer. Even if 1,000 emails arrive in 1 second, they are queued. The consumer processes them at a controlled rate (e.g., respecting Gemini API rate limits).
*   **Resilience & Retries:** Native support for consumer offsets and a Dead Letter Queue (DLQ) ensures no email is lost during transient network failures.

---

## 2. Kafka Component Architecture in Mailora

The system is built around two primary data pipelines facilitated by specific Topics, Producers, and Consumers.

### A. The Email Classification Pipeline

*   **Topic:** `email-classification`
*   **Producer (`emailClassification.producer.js`):** 
    *   Invoked by the `gmail.webhook.controller.js` and `sync.controller.js`.
    *   Extracts the raw email payload (headers, body snippet) and publishes it to the topic.
*   **Consumer (`emailClassification.consumer.js`):**
    *   Listens to the `email-classification` topic.
    *   For each message, it parses the email content.
    *   Calls the Gemini AI API to classify the email (e.g., identifying if it's a job application, extracting the deadline/interview date).
    *   Saves the processed result into MongoDB.
    *   *If the consumer fails (e.g., Gemini API is down), the message is routed to the DLQ for retries.*

### B. The WhatsApp Notification Pipeline

*   **Topic:** `whatsapp-messages`
*   **Producer (`whatsappMessage.producer.js`):**
    *   Invoked by the `reminderScheduler.service.js` (cron jobs running every minute/hour).
    *   When the database querying finds an upcoming deadline (e.g., 24 hours before a scheduled interview), the producer formats a notification payload and publishes it.
*   **Consumer (`whatsappMessage.consumer.js` inside the `whatsapp-service`):**
    *   The standalone `whatsapp-service` microservice listens to this topic.
    *   Upon receiving a message, it interacts with the WhatsApp Business API (or similar provider) to send the reminder to the user's phone.
    *   Completely isolates the heavy lifting of third-party messaging SDKs from the core backend.

---

## 3. Reliability & Fault Tolerance Implementation

### Dead Letter Queue (DLQ) & Retries
A core part of the system's production readiness is handling failures gracefully via `dlq.handler.js`.

1.  **Transient Failures:** If a consumer fails to process a message (e.g., network timeout), it retries based on a configured backoff strategy (e.g., 3 retries).
2.  **Routing to DLQ:** If all retries fail, the message is not discarded. It is published to a specific DLQ topic (e.g., `email-classification-dlq`).
3.  **Manual/Automated Recovery:** A separate process or admin dashboard allows engineers to inspect the DLQ, fix the underlying bug, and replay the messages back into the main topic.

### Consumer Groups & Scalability
*   Consumers belong to a **Consumer Group**. 
*   If the volume of emails increases, we can simply spin up multiple instances of the `emailClassification.consumer`. Kafka will automatically balance the partitions among the available consumers, allowing horizontal scaling without any code changes.

---

## 4. End-to-End Workflows

### Workflow 1: Receiving a Job Interview Email
1.  **Gmail** sends a push notification to our Webhook endpoint.
2.  **Webhook Controller** accepts the request, replies `200 OK` to Gmail immediately, and uses `emailClassification.producer` to send the payload to Kafka.
3.  **Kafka Broker** stores the message durably on disk.
4.  **Email Consumer** pulls the message, asks **Gemini** to extract the interview date, and saves the formatted document to **MongoDB**.

### Workflow 2: Sending a Deadline Reminder
1.  **Cron Scheduler** runs on the main server and queries MongoDB for deadlines happening in the next 24 hours.
2.  **Scheduler** uses `whatsappMessage.producer` to send a message to the `whatsapp-messages` Kafka topic.
3.  **WhatsApp Microservice** pulls the message from Kafka and executes the HTTP request to the WhatsApp API to send the physical message to the user.

---

## 5. Amazon SDE Interview Q&A Preparation

Use these hypothetical questions to frame your understanding of the architecture during an interview:

**Q: Why didn't you just use an in-memory queue like Redis or a simple BullMQ?**
> **A:** "While Redis is great for simple jobs, I chose Kafka for its durability and replayability. Since we are dealing with critical user data (job applications and interview dates), losing an email because the Node.js server crashed before processing it was unacceptable. Kafka stores messages on disk, meaning even if our entire consumer service goes down, the messages are waiting safely in the topic when it boots back up. Furthermore, Kafka allowed us to cleanly split out the WhatsApp service into a completely separate microservice."

**Q: How do you handle Gemini API rate limits if 10,000 emails arrive at once?**
> **A:** "This is exactly why Kafka was introduced. Without Kafka, the webhook endpoint would attempt 10,000 simultaneous connections to Gemini, resulting in HTTP 429 Too Many Requests errors. With Kafka, the 10,000 emails sit safely in the topic. The consumer is configured to poll at a controlled rate (e.g., batch size of 10 or controlled concurrency), acting as a shock absorber. It processes the emails at the speed Gemini can handle, ensuring system stability."

**Q: What happens if a consumer successfully processes a message, saves to the DB, but crashes before acknowledging (committing) the offset to Kafka?**
> **A:** "This scenario results in 'At-Least-Once' delivery. When the consumer restarts, it will fetch the unacknowledged message again. To handle this, our consumer logic must be **idempotent**. When saving to MongoDB, we use unique constraints (like `messageId` or `emailId`) with an `upsert` operation. If the consumer processes the same email twice, the database simply overwrites the existing record rather than creating duplicates, ensuring data consistency."

**Q: Can you explain your retry mechanism? What if a message is fundamentally broken (Poison Pill)?**
> **A:** "We implemented a Dead Letter Queue (DLQ). If a message fails (e.g., due to an API timeout), the consumer retries. However, if the payload is malformed (a poison pill) it will fail every time. After a set number of retries (e.g., 3), the `dlq.handler` catches it and moves it to a DLQ topic. This prevents the poison pill from blocking the entire partition and halting the processing of healthy emails."
