import { useState, useEffect } from "react";

function App() {
  const [message, setMessage] = useState<string>("Loading...");

  useEffect(() => {
    fetch("/api/hello")
      .then((res) => res.json())
      .then((data) => setMessage(data.message))
      .catch(() => setMessage("Failed to connect to API"));
  }, []);

  return (
    <div className="container">
      <h1>Session Scribe</h1>
      <p className="api-response">{message}</p>
    </div>
  );
}

export default App;
