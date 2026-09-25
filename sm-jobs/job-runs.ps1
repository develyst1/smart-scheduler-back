$r = Invoke-RestMethod -Method Get `
  -Uri "http://localhost:4006/internal/jobs/job-runs?limit=20" `
  -Headers @{ "x-internal-secret" = "sid-server-task-schedule" }
$r.runs | Select-Object job, status, startedAt, @{ n = 'finishedAt'; e = { if ($_.finishedAt) { $_.finishedAt } else { '-- NOT FINISHED --' } } } | Format-Table -AutoSize