// ============================================================
// UTILITY
// ============================================================

// Describes a lock_type for member-facing output.
//
// The WIRE VALUE sent to BH is unchanged — BH's schema expects '90LOCK'/'360LOCK'
// and that contract is not ours to break. What changes is how it is DESCRIBED to
// the caller. A 90-day hold is a refund-window mechanism sized to the chargeback
// period; calling it "90LOCK" made it read as a sibling of 360LOCK, competing
// with the commitment tier that actually determines Crescendo status. It is not
// a tier and it does not affect status.
function describeSettlement(lockType) {
  const key = String(lockType || '').toLowerCase();

  if (key === 'none') {
    return {
      type: 'immediate',
      hold_days: 0,
      affects_status: false,
      description: 'Settles immediately. Agent-native transactions carry no refund window.'
    };
  }

  if (key === '360lock') {
    return {
      type: 'commitment',
      hold_days: 360,
      affects_status: true,
      description: '360LOCK — a Crescendo commitment. Committed NCTR counts toward Crescendo status.'
    };
  }

  return {
    type: 'settlement_hold',
    hold_days: 90,
    affects_status: false,
    description: 'Settlement hold. Earned NCTR settles after a 90-day window matching the card refund period. This is a settlement hold, not a Crescendo commitment, and it does not affect status.'
  };
}

export { describeSettlement };
