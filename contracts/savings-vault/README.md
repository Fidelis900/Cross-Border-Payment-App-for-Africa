# Savings Vault Contract

## Overview
The Savings Vault contract allows users to deposit tokens for fixed periods, earn interest over time, and participate in platform yield distributions.

## Operational Runbooks

### SC-036: Fee / Distributor Key Loss & Rotation Runbook

The savings vault relies on authorized distributor addresses:
- **Fee Distributor (`fund_interest_reserve`)**: Address authorized to top up the platform interest reserve pool.
- **Yield Distributor (`distribute_yield`)**: Address authorized to push platform fee yield allocations to vault holders.

#### Incident Scenario
A distributor key (private key or hot wallet) is compromised, lost, or needs scheduled rotation.

#### Immediate Response & Key Rotation
1. **Identify the compromised key** and halt any off-chain automated scripts using it to distribute yield or fund reserves.
2. **Admin Key Authorization**: As long as the admin key is intact, call `set_fee_distributor` and/or `set_yield_distributor` from the admin address to reassign the authorized distributor to a secure new address:
   - `client.set_fee_distributor(&admin, &new_distributor_address)`
   - `client.set_yield_distributor(&admin, &new_distributor_address)`
3. **Execution Latency**: Reassignment takes effect immediately upon transaction inclusion on the Stellar ledger (typically ~5 seconds ledger close time). No timelock or multi-day delay is imposed on distributor rotation, ensuring rapid containment during an incident.

#### Status of Existing User Funds & Accrued Yield
- **No Interruption to User Yield**: Already-accrued interest (`vault.accrued_interest`) and claimed/unclaimed user balances are stored on-ledger in persistent contract storage. Rotating the distributor address does **not** reset or pause user withdrawals, interest claims (`claim_yield`), or standard principal withdrawals (`withdraw`).
- **Safety of Reserves**: The distributor key can only deposit funds into the contract via `fund_interest_reserve` or `distribute_yield`. It has no privilege to drain user principal or siphon off reserve funds.

### SC-035: Yield Accrual Model & Flash-Deposit Analysis
- **Yield & Interest Accrual Model**: Interest accrual (`accrue_interest`) is strictly **time-weighted** continuously based on elapsed seconds:
  $$\text{interest} = \frac{\text{balance} \times \text{rate\_bps} \times \Delta t}{10000 \times \text{SECONDS\_PER\_YEAR}}$$
- Depositing immediately prior to an accrual period and withdrawing immediately after captures only interest proportional to the elapsed seconds ($\Delta t$), making "flash deposit" gaming unviable.

### SC-033: Emergency Mode & Recovery
- The admin can announce emergency mode (`announce_emergency_return`) requiring an on-chain delay period before activation, protecting users while allowing fund returns under exceptional circumstances.
