ALTER TABLE "teachers" ADD COLUMN "work_days" smallint[] DEFAULT '{0,1,2,3,4,5,6}'::smallint[] NOT NULL;
