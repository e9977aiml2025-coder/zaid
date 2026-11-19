# MediSense Real SMS Setup (textbee)

1. Android par textbee app ko registered/online rakho. SIM outgoing SMS active ho.
2. Project folder mein `.env.example` ko copy karke `.env` banao.
3. `.env` mein `SMS_ENABLED=true` aur `TEXTBEE_API_KEY=apni_key` set karo. API key kabhi share mat karo.
4. Node.js 22.5+ install karo. Terminal: `npm install` then `npm run dev`.
5. Website par login -> Patient add karo (contact +91XXXXXXXXXX) -> Prescription add karo -> Reminder add karo.
6. Reminders page par `Send SMS` button click karke manual real SMS test karo.
7. Scheduled SMS ke liye reminder time set karo aur backend running rakho; server local timezone India hona chahiye (`TZ=Asia/Kolkata` recommended).

Note: textbee API success means queued, not delivered. Check actual phone and textbee dashboard. Scheduled reminders are processed only while backend is running. Same minute's reminder is processed once; SMS retry is not automatic. Respect patient consent and SIM/operator limits. No diagnosis or prescribing is performed.
