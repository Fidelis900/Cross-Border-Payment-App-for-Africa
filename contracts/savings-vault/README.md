# Savings Vault Contract

## Emergency Mode State Machine

The savings vault features an admin-controlled emergency mode surface governed by six functions:
1. `announce_emergency`
2. `cancel_emergency`
3. `emergency_withdraw`
4. `activate_emergency`
5. `deactivate_emergency`
6. `emergency_return_funds`

### State Transition Diagram

```
                 +-------------------+
                 |      Normal       |
                 +-------------------+
                   /               \
 announce_emergency/                 \activate_emergency
                  v                   v
     +--------------------+   +--------------------+
     | EmergencyAnnounced |   |  EmergencyActive   |
     +--------------------+   +--------------------+
        |              |         |              |
 cancel_|   emergency_ | deactiv_|   emergency_ |
 emerg. |    withdraw  | ate_em. |  return_funds|
 (t<48h)|     (t>=48h) | (t<48h) |     (t>=48h) |
        v              v         v              v
     +------+       +------+  +------+       +------+
     |Normal|       |Closed|  |Normal|       |Closed|
     +------+       |Vault |  +------+       |Vault |
                    +------+                 +------+
```

### States & Invariants

1. **Normal (Idle)**:
   - `EmergencyWithdrawalAnnounced == 0`
   - `EmergencyActivated == false`
   - Normal deposits and withdrawals operate under standard lock and penalty rules.

2. **EmergencyAnnounced**:
   - `EmergencyWithdrawalAnnounced > 0`
   - Initiated via `announce_emergency(admin)`.
   - Cannot be announced again while already announced (double-announce rejected).
   - Can be cancelled within 48 hours via `cancel_emergency(admin)` -> returns to `Normal`.
   - Cannot be cancelled after 48 hours.
   - After 48 hours, `emergency_withdraw(admin, user)` can be executed -> transfers full vault balance to user, cleans up the vault, and updates `TotalLocked`.

3. **EmergencyActive**:
   - `EmergencyActivated == true`, `EmergencyActivatedAt > 0`
   - Initiated via `activate_emergency(admin)`.
   - Cannot be activated again while already active (double-activate rejected).
   - Can be deactivated via `deactivate_emergency(admin)` -> returns to `Normal`.
   - After 48 hours, `emergency_return_funds(admin, user)` can be executed -> transfers full vault balance to user, cleans up the vault, and updates `TotalLocked`.

### Mutual Exclusivity & Safety

- `emergency_withdraw` and `emergency_return_funds` are mutually exclusive per vault. When either function executes, the user's vault record is deleted from storage (`env.storage().persistent().remove(&vault_key)`). Any subsequent call to `emergency_withdraw`, `emergency_return_funds`, or `withdraw` for that vault will panic with `No vault found for user` or `No balance to return`.
- Calling `deactivate_emergency` without `activate_emergency` panics with `"no emergency active"`.
- Calling `cancel_emergency` without `announce_emergency` panics with `"no emergency announced"`.
- Calling `emergency_withdraw` before 48 hours elapsed panics with `"emergency withdrawal not yet allowed"`.
- Calling `emergency_return_funds` before 48 hours elapsed panics with `"emergency return not yet allowed: 48h not elapsed"`.
