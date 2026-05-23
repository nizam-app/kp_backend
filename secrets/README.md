# Local secrets (not committed)

Place private key files here. **Do not commit** JSON keys to git.

## Firebase (push notifications)

1. Firebase Console → Project settings → **Service accounts** → **Generate new private key**
2. Save the downloaded file as:

   `firebase-service-account.json`

3. In `.env`:

   ```env
   FIREBASE_SERVICE_ACCOUNT_PATH=./secrets/firebase-service-account.json
   ```

Restart the backend after adding the file.
