Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4006/internal/jobs/pay-confirm-0900" `
  -Headers @{ "x-internal-secret" = "sid-server-task-schedule" } `
  -ContentType "application/json" -Body "{}"
