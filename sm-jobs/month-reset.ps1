Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4006/internal/jobs/month-reset" `
  -Headers @{ "x-internal-secret" = "sid-server-task-schedule" } `
  -ContentType "application/json" -Body "{}"