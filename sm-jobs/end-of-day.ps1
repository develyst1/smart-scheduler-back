Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4006/internal/jobs/end-of-day" `
  -Headers @{ "x-internal-secret" = "sid-server-task-schedule" } `
  -ContentType "application/json" -Body "{}"