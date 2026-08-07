# Object store note

The object store interface is S3-shaped: put, get, and exists by string key. The filesystem adapter implements it today. A MinIO backend may replace it later without changing callers.

Keys look like "corpus/<doc_id>_<hash>.pdf". Put writes to a temporary file first, then renames, so a crash cannot leave a half object.
