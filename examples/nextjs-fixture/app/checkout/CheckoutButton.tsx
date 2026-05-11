"use client";

import { useState } from "react";

export function CheckoutButton() {
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    // GET — list bugs to show a stub interaction
    await fetch("/api/bugs");
    // POST — create one
    await fetch("/api/bugs", {
      method: "POST",
      body: JSON.stringify({ title: "from-checkout" }),
    });
    setLoading(false);
    alert("paid");
  };

  return (
    <button onClick={submit} disabled={loading}>
      Pay
    </button>
  );
}
