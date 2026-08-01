Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4006/internal/jobs/daily-digest" `
  -Headers @{ "x-internal-secret" = "sid-server-task-schedule" } `
  -ContentType "application/json" -Body "{}"