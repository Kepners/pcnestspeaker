# Run this as Administrator to add the firewall rule
$ruleName = "PC Nest Speaker"

# Check if rule exists
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($existingRule) {
    Write-Host "Firewall rule already exists!" -ForegroundColor Green
} else {
    try {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -LocalPort 8000-8010 -Protocol TCP -Action Allow
        Write-Host "Firewall rule added successfully!" -ForegroundColor Green
    } catch {
        Write-Host "Error: Run this script as Administrator" -ForegroundColor Red
        Write-Host $_.Exception.Message
    }
}

# Show the rule
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Format-List DisplayName, Enabled, Direction, Action
