// Public settings. The Supabase anon key is meant to be public: the database itself decides what
// each caller may do (row-level security and the functions in supabase/schema.sql).
export const VERSION = '2.10.4';

export const CONFIG = {
  shortName: 'AlPhi Cuts',
  siteUrl: 'https://alphi-cuts.pages.dev/',
  timeZone: 'Africa/Lusaka',
  supabase: {
    url: 'https://dbiojclfbqmvpvmqsfhv.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRiaW9qY2xmYnFtdnB2bXFzZmh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2MDE5MDIsImV4cCI6MjEwNjE3NzkwMn0.mVHW9t3J1LUPzIqxzhccXm07JanRTwXt41rJwfLgU8A',
  },
};
