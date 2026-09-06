CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('patient', 'clinician')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinician_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  biography text NOT NULL,
  specialty text NOT NULL,
  timezone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE availability_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinician_id uuid NOT NULL REFERENCES clinician_profiles(user_id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_duration CHECK (end_at = start_at + interval '30 minutes'),
  CONSTRAINT clinician_slot_overlap EXCLUDE USING gist
    (clinician_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
    WHERE (status = 'open')
);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid NOT NULL REFERENCES availability_slots(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('booked', 'cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_cancellation_metadata CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status = 'booked' AND cancelled_at IS NULL AND cancelled_by IS NULL)
  )
);

CREATE UNIQUE INDEX one_active_booking_per_slot
  ON appointments(slot_id) WHERE status = 'booked';
