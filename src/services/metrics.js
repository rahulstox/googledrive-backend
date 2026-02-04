import client from "prom-client";

// Create a Registry which registers the metrics
const register = new client.Registry();

// Add a default label which is added to all metrics
register.setDefaultLabels({
  app: "krypton-drive-backend",
});

// Enable the collection of default metrics
client.collectDefaultMetrics({ register });

// Define metrics
export const registrationTotal = new client.Counter({
  name: "registration_total",
  help: "Total number of registration requests",
  labelNames: ["status"], // success, failed
});

export const registrationDuration = new client.Histogram({
  name: "registration_duration_seconds",
  help: "Duration of registration process in seconds",
  buckets: [0.1, 0.5, 1, 2, 5],
});

export const emailSendTotal = new client.Counter({
  name: "email_send_total",
  help: "Total number of activation emails sent",
  labelNames: ["status"], // success, failed, timeout
});

export const activationTotal = new client.Counter({
  name: "activation_total",
  help: "Total number of account activations",
  labelNames: ["status"], // success, failed
});

export const loginDuration = new client.Histogram({
  name: "login_duration_seconds",
  help: "Duration of login process in seconds",
  buckets: [0.1, 0.5, 1, 2, 5],
});

export const cacheOps = new client.Counter({
  name: "cache_ops_total",
  help: "Total number of cache operations",
  labelNames: ["operation", "status"], // get/set/del, hit/miss/error
});

export const metricsRegistry = register;
