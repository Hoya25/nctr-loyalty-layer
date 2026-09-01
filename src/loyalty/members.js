// ============================================================
// BH ADMIN-API HELPERS
// ============================================================

async function lookupMember(email, env) {
  const response = await fetch(
    `${env.BH_SUPABASE_URL}/functions/v1/admin-api`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.BH_ANON_KEY}`,
        'x-sync-secret': env.SYNC_SECRET
      },
      body: JSON.stringify({
        action: 'lookup_member_by_email',
        email: email
      })
    }
  );

  if (!response.ok) {
    console.error('Member lookup failed:', response.status);
    return null;
  }

  const data = await response.json();
  return data.member || null;
}

async function creditMember(userId, nctrAmount, lockType, source, merchantId, env) {
  const response = await fetch(
    `${env.BH_SUPABASE_URL}/functions/v1/admin-api`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.BH_ANON_KEY}`,
        'x-sync-secret': env.SYNC_SECRET
      },
      body: JSON.stringify({
        action: 'credit_member',
        user_id: userId,
        nctr_amount: nctrAmount,
        lock_type: lockType,
        source: source,
        merchant_id: merchantId,
        note: `Loyalty wrap: ${nctrAmount} NCTR via ${source}`
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    return { success: false, error: errText };
  }

  const data = await response.json();
  return {
    success: true,
    new_balance: data.new_balance || 0
  };
}

export { lookupMember, creditMember };
