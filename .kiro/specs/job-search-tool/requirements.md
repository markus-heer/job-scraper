# Requirements Document

## Introduction

The Job_Tool is a job search tool for a single, non-technical user. The Job_Tool retrieves job postings from several job platforms (Glassdoor, Jobvector, Indeed, Stepstone) with Playwright, normalizes them, has them assessed for relevance by a Large Language Model, determines the commute from a configurable home address to the work location and stores the results in a PostgreSQL database that runs in a Docker container.

"Local" means in this project that the Job_Tool runs locally on a developer machine, with no cloud deployment for now. "Local" does not mean that data has to stay on the machine: Platform requests, routing queries and AI_Provider requests leave the machine by design.

Home_Address and Commute_Threshold are configurable values with the defaults "Hörkherstraße 1d, 80689 München" and 60 minutes. Where the available data yields no usable Commute_Time, the commute determination falls back to the value "unknown" and the Job_Posting is retained.

Search criteria live in the source code. A Default_Search_Profile (project manager in the pharmaceutical field in and around Munich) applies to every Platform, and an optional Platform_Override per Platform replaces individual Criterion_Field values. The user does not edit search criteria: a developer changes the typed constants in the source code and restarts the Job_Tool. The Web_App presents the effective criteria read-only.

Language convention: this document, the Steering_Docs, the source code and the code comments are written in English. The user interface of the Web_App, every label, status message and error message shown to the user and every Relevance_Reason text are German-language, because the target user is a German speaker. The English wording of this document therefore states German-language output as an explicit requirement wherever the user sees the text.

Operation is carried out entirely through the Web_App, which is started with a single npm script. A Scrape_Run can be started from the Web_App; progress is shown in the Log_View in near real time.

This document describes the intended behaviour (requirements) only. Technical realization, component boundaries and test strategy are covered in the design document.

## Glossary

- **Job_Tool**: The overall system consisting of Web_App, API_Service, Scraper_Service, Relevance_Service, Commute_Service, Posting_Store and Start_Script.
- **Web_App**: The browser-based user interface through which the user reviews Job_Posting, views the search criteria and starts a Scrape_Run.
- **API_Service**: The server-side interface through which the Web_App reads data and triggers a Scrape_Run.
- **Scraper_Service**: The component that executes a Scrape_Run, coordinates the Platform_Adapter and produces status messages.
- **Platform_Adapter**: A platform-specific module that retrieves the publicly accessible result list of exactly one job platform and normalizes it into Job_Posting.
- **Platform**: A job board for which a Platform_Adapter exists (Glassdoor, Jobvector, Indeed, Stepstone).
- **Scrape_Run**: A single execution of the Scraper_Service across all activated Platform_Adapter, with identifier, start time, end time and Run_Outcome.
- **Run_Outcome**: The final state of a finished Scrape_Run. The Run_Outcome takes exactly one of the following values: "completed" (every activated Platform_Adapter was executed to the end), "cancelled by user" (the user ended the Scrape_Run), "cancelled by time limit" (the runtime limit of the Scrape_Run was reached). A Scrape_Run that has not yet finished carries the status "running" and no Run_Outcome.
- **Platform_Status**: The configuration state of exactly one Platform determined at startup of the API_Service, or the result of a Scrape_Run for exactly one Platform. The Platform_Status takes exactly one of the following 14 values: "completed", "disabled", "incomplete configuration", "sign-in required", "platform blocked", "platform unreachable", "page layout unknown", "page limit reached", "fetch rate limited", "failed", "excluded by robots.txt", "robots.txt unavailable", "cancelled by time limit", "not yet run". This value list is complete and closed; further values are not permitted.
- **Job_Posting**: A normalized job advertisement with the fields title, employer, work location, publication date, source URL, platform name, Posting_Id and description text.
- **Posting_Status**: The status of a stored Job_Posting. The Posting_Status takes exactly one of the two values "listed" or "no longer listed". This value list is complete and closed.
- **Interest_Flag**: A marking of a Job_Posting that is independent of the Posting_Status and that the user sets and withdraws. The Interest_Flag takes exactly one of the two values "unmarked" or "not interesting" and leaves the Posting_Status unchanged.
- **Partial_Result**: The set of Job_Posting that a Platform_Adapter has already read before ending its retrieval, where that retrieval ends with a Platform_Status other than "completed".
- **Posting_Id**: The identifier assigned by a Platform that is unique for a job advertisement within that Platform.
- **Result_Page**: A single result page of the result list of a Platform that a Platform_Adapter loads with exactly one page request.
- **Search_Profile**: A set of search criteria (job title, title synonyms, industry, search location, search radius, employment type, publication period).
- **Criterion_Field**: A single field of a Search_Profile.
- **Default_Search_Profile**: The Search_Profile defined as a typed constant in the source code that applies to every Platform without a Platform_Override.
- **Platform_Override**: A partial Search_Profile defined as a typed constant in the source code for exactly one Platform that replaces individual Criterion_Field of the Default_Search_Profile.
- **Profile_Resolver**: The component that resolves the Default_Search_Profile and the optional Platform_Override of a Platform into exactly one effective Search_Profile.
- **Relevance_Service**: The component that has a Job_Posting assessed by a Large Language Model through the AI_Provider.
- **Relevance_Verdict**: The result of a relevance assessment of a Job_Posting. The Relevance_Verdict takes exactly one of the following four values: "relevant", "not relevant", "uncertain", "not assessed". This value list is complete and closed.
- **Relevance_Reason**: The short German-language justification text of a Relevance_Verdict that the Web_App displays.
- **AI_Provider**: The external provider of the Large Language Model used by the Relevance_Service, with the default model Claude Sonnet through the Anthropic API.
- **Commute_Service**: The component that determines the Commute_Time from the Home_Address to a work location.
- **Home_Address**: The configurable starting address of the commute determination, default value "Hörkherstraße 1d, 80689 München" (Munich-Laim).
- **Commute_Time**: The travel duration in minutes determined from the Home_Address to the work location of a Job_Posting for one mode of transport.
- **Best_Commute_Time**: The shorter of the two Commute_Time values for the modes of transport bicycle and public transport, or the value "unknown" where neither Commute_Time can be determined.
- **Commute_Threshold**: The configurable limit for the Best_Commute_Time, default value 60 minutes, permitted range 5 to 240 minutes.
- **Routing_Provider**: The service that supplies travel durations for bicycle and public transport.
- **Posting_Store**: The local PostgreSQL database including its access layer, in which Job_Posting, Scrape_Run and relevance assessments are stored persistently.
- **Log_Stream**: The transport path through which status messages of a running Scrape_Run reach the Web_App.
- **Log_View**: The view of the Web_App that presents the status messages of a Scrape_Run.
- **Start_Script**: The npm script that updates the repository, installs dependencies and starts database, API_Service and Web_App locally.
- **Steering_Docs**: The files in the directory `.kiro/steering` that describe project context and conventions for further development.

## Requirements

### Requirement 1: Local start with a single command

**User Story:** As a user, I want to start the Job_Tool with a single command, so that I can begin the job search without technical knowledge.

#### Acceptance Criteria

1. WHEN the user runs the Start_Script, THE Start_Script SHALL execute the following steps in exactly this order: (1) run `git pull` restricted to fast-forward, (2) run `pnpm install`, (3) check the Playwright browser binaries and install the missing binaries, (4) start the PostgreSQL container, (5) apply pending Prisma migrations, (6) start the API_Service, (7) serve the Web_App at a local URL, and SHALL begin each step only after the preceding step has been confirmed as ready.
2. WHEN the Start_Script executes step 1, step 2 or step 3, THE Start_Script SHALL print exactly one German-language progress line per step, so that the user recognizes the current step.
3. IF the Git working tree contains uncommitted changes, THEN THE Start_Script SHALL skip `git pull`, print a German-language warning that names the uncommitted changes as the reason and continue with step 2.
4. IF `git pull` fails because no network connection is available or because no fast-forward is possible, THEN THE Start_Script SHALL print a German-language warning that names the detected cause, leave the local Git state unchanged and continue with step 2.
5. THE Start_Script SHALL limit its Git operations to a fast-forward-only `git pull` and SHALL leave the local commit history and the local working tree unchanged in every other respect, excluding `git reset`, `git checkout --force`, `git clean` and the creation of a merge commit from its operations.
6. IF `pnpm install` fails, THEN THE Start_Script SHALL execute none of the remaining steps, print a German-language error message with the reported cause and exit with a non-zero exit code.
7. IF the installation of a missing Playwright browser binary fails, THEN THE Start_Script SHALL execute none of the remaining steps, print a German-language error message naming the affected browser and exit with a non-zero exit code.
8. THE Start_Script SHALL provide a switch that skips step 1 and step 2 and begins with step 3, so that the Job_Tool starts without a network connection.
9. WHEN the Web_App accepts requests, THE Start_Script SHALL print within 5 seconds a console line that contains the complete callable local URL of the Web_App composed of host name and configured port.
10. WHILE a PostgreSQL container from an earlier start is running and accepting connections, WHEN the user runs the Start_Script, THE Start_Script SHALL reuse that container, create no second container, leave the existing data in the Posting_Store unchanged and apply pending Prisma migrations.
11. IF the PostgreSQL container, the API_Service or the Web_App is not ready within 60 seconds after its own start step, where readiness is checked at least every 2 seconds, THEN THE Start_Script SHALL execute none of the remaining steps, print a German-language error message with the name of the affected service and the detected cause (service unreachable or port occupied) and exit with a non-zero exit code.
12. THE Job_Tool SHALL read every configuration value required for execution from a local environment file that is excluded from version control, and SHALL provide an example file in the repository that contains every required key with placeholders and without real secrets.
13. IF the container runtime is unreachable when the Start_Script runs, THEN THE Start_Script SHALL stop before step 4, print a German-language error message with the instruction to start the container runtime and exit with a non-zero exit code.
14. IF applying a pending Prisma migration fails, THEN THE Start_Script SHALL start neither the API_Service nor the Web_App, leave the existing data in the Posting_Store unchanged, print a German-language error message with the name of the failed migration and exit with a non-zero exit code.
15. IF a required configuration value is missing or empty in the local environment file, THEN THE Start_Script SHALL start no service, print a German-language error message with the names of all missing configuration keys and exit with a non-zero exit code.
16. THE Job_Tool SHALL run completely on a single developer machine without cloud infrastructure and SHALL require no deployment target, so that the Start_Script and the Web_App are the only entry points needed for operation.

### Requirement 2: Usability for a non-technical user

**User Story:** As a non-technical user, I want a simple German-language interface, so that I can operate the Job_Tool without training.

#### Acceptance Criteria

1. THE Web_App SHALL present every label, button text, hint, status message and error message that the Web_App itself produces in German, excluding the original advertisement texts taken from a Job_Posting, which are presented unchanged.
2. THE Web_App SHALL make the functions "Suchlauf starten" (start scrape run), "Treffer ansehen" (review job postings), "Suchkriterien ansehen" (view search criteria, read-only) and "Log öffnen" (open log) reachable from the landing page through one permanently visible, named control each with at most two activations (mouse click or keyboard activation).
3. THE Web_App SHALL meet the success criteria of WCAG 2.1 level AA such that every function is reachable and triggerable entirely without a mouse through the keyboard, the control currently in focus carries a visible focus indicator with a contrast ratio of at least 3:1 against the background, every form field has a visible label programmatically associated with the field, and text content has a contrast ratio of at least 4.5:1 against the background.
4. THE Web_App SHALL identify every state information of a Scrape_Run and of a Job_Posting through text or through a symbol with a textual alternative in addition to colour, so that the state is unambiguously recognizable without colour perception.
5. IF an action triggered by the user fails, THEN THE Web_App SHALL display within 2 seconds after detecting the failure a German-language message that names the cause and exactly one recommended next step, and SHALL provide technical error details in the Log_View only.
6. IF an action triggered by the user fails, THEN THE Web_App SHALL preserve every input already entered by the user unchanged and keep the same action triggerable without re-entry.
7. WHILE a Scrape_Run is running, THE Web_App SHALL present a German-language status display with progress information, update that display at least every 5 seconds and mark the control "Suchlauf starten" as disabled.
8. IF a Scrape_Run yields no Job_Posting, THEN THE Web_App SHALL display, instead of an empty list, a German-language hint that names the result "keine Treffer" and refers to the read-only function "Suchkriterien ansehen" as the next step.

### Requirement 3: Code-defined default search profile

**User Story:** As a developer, I want the default search criteria for the target role defined as a typed constant in the source code, so that the user can start a meaningful Scrape_Run without any input.

#### Acceptance Criteria

1. THE Job_Tool SHALL define the Default_Search_Profile as exactly one typed constant in the source code, with the default values job title "Projektmanagerin", industry "Pharma and Life Science", search location "München" and search radius 50 kilometres.
2. THE Default_Search_Profile SHALL contain a list of 4 to 20 title synonyms with 2 to 100 characters each, which in the delivered state includes at least "Projektmanager", "Project Manager", "Projektleiterin" and "Projektleiter".
3. THE Default_Search_Profile SHALL be available for every Scrape_Run without user input and independently of the content of the Posting_Store.
4. WHEN a Scrape_Run is started, THE Scraper_Service SHALL use the Default_Search_Profile as Search_Profile for every Platform without a Platform_Override.
5. WHEN the API_Service starts, THE API_Service SHALL validate the Default_Search_Profile constant against the mandatory fields and value ranges defined in criteria 3.1 and 3.2, where job title, industry and search location carry at most 100 characters each and the search radius is an integer from 1 to 200 kilometres.
6. IF the validation according to criterion 3.5 finds the Default_Search_Profile constant invalid, THEN THE API_Service SHALL stop the startup before accepting the first request, print a German-language error message that names every affected Criterion_Field with its permitted value range and exit with a non-zero exit code.
7. WHEN the API_Service starts, THE API_Service SHALL write the Default_Search_Profile with the value of every Criterion_Field to the Log_Stream.
8. WHEN a Scrape_Run starts, THE Scraper_Service SHALL write the effective Search_Profile of every activated Platform with the value of every Criterion_Field to the Log_Stream, so that the criteria applied in that Scrape_Run remain traceable.
9. WHERE a developer changes the Default_Search_Profile constant in the source code, THE Job_Tool SHALL apply the changed values from the next start of the API_Service onward.

### Requirement 4: Code-defined per-platform search criteria

**User Story:** As a developer, I want per-platform search criteria defined as typed constants in the source code, so that a weak result list of a single Platform can be addressed without changing the criteria of the remaining Platform.

#### Acceptance Criteria

1. THE Job_Tool SHALL define at most one Platform_Override per Platform as a typed constant in the source code, at most four Platform_Override in total, and SHALL set in each Platform_Override only those Criterion_Field that replace the value of the Default_Search_Profile.
2. THE Job_Tool SHALL declare the set of Criterion_Field supported by each Platform and the subset of Criterion_Field that each Platform requires as mandatory in the source code.
3. WHERE a Platform_Override is defined for a Platform, WHEN a Scrape_Run starts for that Platform, THE Scraper_Service SHALL use the value of the Platform_Override for every Criterion_Field set in the Platform_Override and the value of the Default_Search_Profile for every Criterion_Field not set in the Platform_Override.
4. WHERE no Platform_Override is defined for a Platform, WHEN a Scrape_Run starts for that Platform, THE Scraper_Service SHALL use the Criterion_Field of the Default_Search_Profile only.
5. THE Job_Tool SHALL declare the types of the Platform_Override such that a Platform_Override which sets a Criterion_Field unsupported by its Platform is reported as an error by the type check and keeps the build from succeeding.
6. THE Job_Tool SHALL mark every Platform in the source code as activated or deactivated.
7. WHERE a Platform is marked as deactivated in the source code, WHEN a Scrape_Run starts, THE Scraper_Service SHALL execute no request for that Platform, deliver no Job_Posting and report the Platform_Status "disabled" for that Platform in the result of the Scrape_Run.
8. WHEN the API_Service starts, THE API_Service SHALL determine for every activated Platform whether Platform_Override and Default_Search_Profile together resolve a complete set of the Criterion_Field that this Platform requires as mandatory.
9. IF the determination according to criterion 4.8 resolves no complete set of mandatory Criterion_Field for an activated Platform, THEN THE API_Service SHALL set the Platform_Status of that Platform to "incomplete configuration", write a German-language message with the platform name and the missing field names to the Log_Stream and keep serving the remaining Platform.
10. WHERE an activated Platform carries the Platform_Status "incomplete configuration", WHEN a Scrape_Run starts, THE Scraper_Service SHALL skip that Platform and report the Platform_Status "incomplete configuration" together with the missing field names in the result of the Scrape_Run.
11. WHEN the user opens the read-only view of the search criteria, THE Web_App SHALL display within 3 seconds, for every supported Platform, the effective Search_Profile with the resolved value of every Criterion_Field supported by that Platform, and SHALL omit every Criterion_Field not supported by that Platform.
12. WHILE the read-only view of the search criteria is displayed, THE Web_App SHALL mark every displayed Criterion_Field with exactly one of the two distinguishable German-language states "aus Standardprofil" (from default) or "überschrieben" (overridden).
13. THE Web_App SHALL present the Default_Search_Profile, every Platform_Override and every effective Search_Profile as read-only content, and SHALL refer the user to the Steering_Docs for the way these constants are changed in the source code.

### Requirement 5: Search profile resolution

**User Story:** As a developer, I want the resolution of default and per-platform criteria to follow one documented rule, so that the criteria applied in a Scrape_Run are predictable.

#### Acceptance Criteria

1. WHEN a Scrape_Run resolves the criteria of a Platform, THE Profile_Resolver SHALL return exactly one effective Search_Profile from the Default_Search_Profile and the optional Platform_Override of that Platform.
2. WHEN the Profile_Resolver resolves a Criterion_Field that the Platform_Override of the Platform sets, THE Profile_Resolver SHALL take the value of the Platform_Override.
3. WHEN the Profile_Resolver resolves a Criterion_Field that the Platform_Override of the Platform leaves unset, THE Profile_Resolver SHALL take the value of the Default_Search_Profile.
4. FOR ALL Platform and FOR ALL valid combinations of Default_Search_Profile and Platform_Override, THE Profile_Resolver SHALL return exactly one effective Search_Profile that carries exactly one value for every Criterion_Field declared as supported by that Platform (totality property).
5. FOR ALL Platform and FOR ALL valid combinations of Default_Search_Profile and Platform_Override, THE Profile_Resolver SHALL return for repeated resolutions of the same inputs a result that is value-equal to the result of the first resolution, where value-equality means an identical set of Criterion_Field names, an identical value per Criterion_Field name and an identical order of list elements (determinism and idempotence property).
6. FOR ALL Platform and FOR ALL valid combinations of Default_Search_Profile and Platform_Override, THE Profile_Resolver SHALL return a result in which every Criterion_Field is value-equal either to the Criterion_Field of the Platform_Override or to the Criterion_Field of the Default_Search_Profile, and is value-equal to the Default_Search_Profile only where the Platform_Override leaves that Criterion_Field unset (provenance property).
7. FOR ALL Platform, THE Profile_Resolver SHALL return a result that contains Criterion_Field supported by that Platform only (support property).
8. IF the Platform_Override of a Platform leaves a mandatory Criterion_Field of that Platform unset and the Default_Search_Profile carries no value for that Criterion_Field, THEN THE Profile_Resolver SHALL return no Search_Profile and return an error that names the platform name and every missing Criterion_Field.

### Requirement 6: Retrieval of job postings through platform adapters

**User Story:** As a user, I want to see job postings from several job boards in one overview, so that I do not have to search each website separately.

#### Acceptance Criteria

1. THE Scraper_Service SHALL provide exactly one Platform_Adapter per Platform for Glassdoor, Jobvector, Indeed and Stepstone.
2. WHEN a Scrape_Run is started, THE Platform_Adapter SHALL retrieve the publicly accessible result list of its Platform with Playwright, SHALL respect the page limit defined in acceptance criterion 13.3 and SHALL abort the retrieval of a single Result_Page after at most 30 seconds.
3. THE Platform_Adapter SHALL normalize every Job_Posting read into the fields title (at most 200 characters), employer (at most 150 characters), work location (at most 150 characters), publication date (ISO 8601 format), source URL, platform name, Posting_Id and description text (at most 10,000 characters), and SHALL truncate longer values to the stated upper limit.
4. WHEN a Platform_Adapter reads a relative date such as "vor 3 Tagen", THE Platform_Adapter SHALL convert that date relative to the start time of the Scrape_Run into an absolute date in ISO 8601 format.
5. IF one of the fields title, source URL or Posting_Id is missing or contains whitespace only in a Job_Posting that has been read, THEN THE Platform_Adapter SHALL discard that Job_Posting, report the event with platform name and source URL in the Log_Stream and continue the retrieval of the remaining Job_Posting.
6. THE Scraper_Service SHALL integrate every Platform_Adapter through one uniform adapter interface, so that a further Platform_Adapter takes effect solely by registering at that interface and without a change to the source code of the Scraper_Service.
7. IF a Platform_Adapter recognizes no single readable Job_Posting on a Result_Page loaded within the time limit, THEN THE Platform_Adapter SHALL report the Platform_Status "page layout unknown" with platform name and source URL in the Log_Stream, end the retrieval for that Platform and continue the Scrape_Run for the remaining Platform unchanged.
8. IF an optional field (employer, work location, publication date or description text) is missing in a Job_Posting that has been read, THEN THE Platform_Adapter SHALL mark the affected field as empty and pass the Job_Posting on with the remaining fields.
9. IF a relative or absolute date cannot be converted into a date in ISO 8601 format, THEN THE Platform_Adapter SHALL mark the field publication date as empty, report the event with platform name and source URL in the Log_Stream and retain the Job_Posting.
10. IF a Platform does not answer the retrieval of a Result_Page within 30 seconds, THEN THE Platform_Adapter SHALL repeat the retrieval at most 2 further times with an interval of at least 2 seconds each, afterwards report the Platform_Status "platform unreachable" with the platform name in the Log_Stream and retain the Job_Posting already read.

### Requirement 7: Handling of platforms that require sign-in

**User Story:** As a user, I want to understand when a Platform shows its results only after sign-in, so that I can interpret the gap in the results.

#### Acceptance Criteria

1. THE Job_Tool SHALL retrieve content of a Platform that is reachable without sign-in, without registration and without transmitting credentials only.
2. WHEN a Platform_Adapter observes at least one of the following characteristics while retrieving the result list — a redirect to a sign-in or registration page, a sign-in or registration overlay covering the result list, or a result list with 0 readable Job_Posting together with a displayed sign-in prompt — THE Platform_Adapter SHALL end the retrieval of that Platform within 5 seconds after the observation and report the Platform_Status "sign-in required" together with the platform name.
3. WHEN a Platform_Adapter reports the Platform_Status "sign-in required", THE Scraper_Service SHALL continue to execute the remaining Platform_Adapter of the Scrape_Run unchanged and complete the Scrape_Run regularly.
4. WHEN a Scrape_Run is completed, THE Web_App SHALL display in the summary of the Scrape_Run exactly one Platform_Status per Platform requested in that Scrape_Run, the number of Job_Posting taken over from that Platform and, where at least one Platform carries a Platform_Status other than "completed", a hint that the result list is incomplete.
5. THE Job_Tool SHALL keep credentials for Platform out of storage and out of every Platform request, and SHALL leave every sign-in form and registration form unfilled and unsubmitted.
6. IF a Platform_Adapter receives a Captcha page or bot check page during a retrieval, THEN THE Platform_Adapter SHALL leave the check unanswered, end the retrieval of that Platform within 5 seconds and report the Platform_Status "platform blocked".
7. IF a Platform_Adapter has already read Job_Posting before a sign-in prompt or a Captcha check occurs, THEN THE Platform_Adapter SHALL pass the Job_Posting already read to the Scraper_Service and mark them as Partial_Result of that Platform.
8. IF the Platform_Status "sign-in required" or "platform blocked" has been reported for a Platform in the running Scrape_Run, THEN THE Scraper_Service SHALL start no further retrieval attempt for that Platform within the same Scrape_Run (at most 0 repetitions).

### Requirement 8: Commute reachability of the work location

**User Story:** As a user, I want to see which positions I can reach from home in under an hour by bicycle or public transport, so that I only consider realistically commutable positions.

#### Acceptance Criteria

1. WHEN a Job_Posting with a work location resolvable into coordinates is stored in the Posting_Store, THE Commute_Service SHALL determine the Commute_Time from the Home_Address to the work location for the modes of transport bicycle and public transport through the Routing_Provider, where the reference point for public transport is an arrival at 09:00 on the next working day (Monday to Friday).
2. THE Commute_Service SHALL store per Job_Posting both Commute_Time values rounded up to whole minutes in the range from 1 to 600 minutes, as well as the Best_Commute_Time (the smaller of the two Commute_Time values) together with its mode of transport, in the Posting_Store, and SHALL store a determined Commute_Time above 600 minutes as "unknown".
3. WHEN the Web_App presents a Job_Posting with a Best_Commute_Time of at most the Commute_Threshold, THE Web_App SHALL mark that Job_Posting with the hint "gut erreichbar" (well reachable).
4. THE Web_App SHALL display per Job_Posting the Best_Commute_Time as an integer number of minutes and its mode of transport (bicycle or public transport).
5. IF the work location of a Job_Posting cannot be resolved into coordinates by rule-based parsing because the value is absent or contains no place reference below country level (for example "Deutschland" or "Remote") and the Relevance_Service is deactivated, THEN THE Commute_Service SHALL store the Best_Commute_Time as "unknown", keep the Job_Posting in the Posting_Store and repeat the determination only after the work location value of that Job_Posting has changed.
6. IF the work location of a Job_Posting cannot be transformed into a geocodable place name by rule-based parsing and the Relevance_Service is activated, THEN THE Commute_Service SHALL request one normalization of the free-text work location into a geocodable place name from the AI_Provider, cache the returned place name, and store the Best_Commute_Time as "unknown" where the place remains unresolvable after that normalization.
7. THE Commute_Service SHALL request the normalization according to criterion 8.6 at most once per distinct free-text work location value and SHALL reuse the cached place name for every further Job_Posting with the same free-text work location value.
8. IF a query to the Routing_Provider fails or does not answer within 10 seconds, THEN THE Commute_Service SHALL repeat the query up to three times and, after an unsuccessful last attempt, store the Best_Commute_Time as "unknown", keep the Job_Posting in the Posting_Store and repeat the determination in the next Scrape_Run.
9. THE Commute_Service SHALL cache determined Commute_Time values per combination of Home_Address, target coordinate and mode of transport for at most 30 days and SHALL reuse them within that period for further Job_Posting with the same combination without querying the Routing_Provider again.
10. THE Job_Tool SHALL hold Home_Address and Commute_Threshold as configurable values, with the default "Hörkherstraße 1d, 80689 München" for the Home_Address and 60 minutes for the Commute_Threshold, which is limited to values from 5 to 240 minutes.
11. WHERE the user activates the filter "nur gut erreichbare Treffer" (well reachable only), THE Web_App SHALL display Job_Posting with a Best_Commute_Time of at most the Commute_Threshold only and SHALL hide Job_Posting with the Best_Commute_Time "unknown".
12. IF the work location of a Job_Posting is resolvable at the level of a municipality or a district only (for example "München" alone), THEN THE Commute_Service SHALL use the centroid coordinate of that municipality or district as target coordinate and mark the Commute_Time values of that Job_Posting as "imprecise" in the Posting_Store.
13. WHEN the Web_App presents a Job_Posting with the Best_Commute_Time "unknown", THE Web_App SHALL display the hint "Erreichbarkeit unbekannt" (reachability unknown) instead of a number of minutes.
14. IF a configured Commute_Threshold lies outside the range from 5 to 240 minutes or is not an integer, THEN THE Job_Tool SHALL reject the configuration change, retain the previously valid value unchanged and output an error hint that names the permitted value range.

### Requirement 9: Persistent storage and deduplication of job postings

**User Story:** As a user, I want found positions stored persistently and listed only once, so that the overview stays usable across several scrape runs.

#### Acceptance Criteria

1. THE Posting_Store SHALL store per Job_Posting the fields from acceptance criterion 6.3 as well as the time of first recording, the time of the last sighting, the identifier of the recording Scrape_Run and the Posting_Status, where both times are stored as ISO 8601 timestamps in UTC and the Posting_Status takes exactly one of the values "listed" or "no longer listed".
2. THE Posting_Store SHALL treat the combination of platform name and Posting_Id as the unique key of a Job_Posting, compare both values character-exactly after removing leading and trailing whitespace and hold at most one record per combination.
3. WHEN a Job_Posting with an already stored combination of platform name and Posting_Id is recorded, THE Posting_Store SHALL update the existing record without creating a further record, overwrite the fields title, employer, work location, publication date, source URL and description text with the values of the running Scrape_Run, set the time of the last sighting to the start time of the running Scrape_Run and leave the time of first recording, the identifier of the recording Scrape_Run and the Interest_Flag unchanged.
4. FOR ALL result lists of a Platform with at most 250 Job_Posting, THE Posting_Store SHALL produce from applying the same result list twice with the same Scrape_Run start time the same data state as from applying it once, measured by the number of stored Job_Posting and by every field value per Job_Posting from acceptance criterion 9.1 (idempotence property).
5. WHEN a Scrape_Run reaches the Run_Outcome "completed" and the Platform_Adapter of a Platform has reported the Platform_Status "completed" in that Scrape_Run, THE Posting_Store SHALL set the Posting_Status to "no longer listed" for every previously stored Job_Posting of that Platform that is absent from the result list of that Scrape_Run, and SHALL retain every remaining field value of that record.
6. THE Job_Tool SHALL apply changes to the database schema through versioned migrations only, execute every migration exactly once in ascending version order and retain already stored Job_Posting, Scrape_Run and relevance assessments.
7. IF a Scrape_Run reaches a Run_Outcome other than "completed" or the Platform_Adapter of a Platform has reported a Platform_Status other than "completed", THEN THE Posting_Store SHALL leave the Posting_Status of every previously stored Job_Posting of that Platform unchanged and set no Job_Posting to "no longer listed".
8. WHEN a Job_Posting with the Posting_Status "no longer listed" is contained again in the result list of a Scrape_Run of the same Platform, THE Posting_Store SHALL reset the Posting_Status of that Job_Posting to "listed" and leave the time of first recording unchanged.
9. IF storing a Job_Posting fails, THEN THE Posting_Store SHALL leave the affected record unchanged in the state before the write attempt, report the failure with platform name and Posting_Id in the Log_Stream and continue storing the remaining Job_Posting of the running Scrape_Run.

### Requirement 10: Reviewing job postings in the web application

**User Story:** As a user, I want to review, filter and sort the stored job postings clearly, so that I find suitable positions quickly.

#### Acceptance Criteria

1. WHEN the user opens the posting overview, THE Web_App SHALL display the Job_Posting stored in the Posting_Store within 3 seconds as a list with title, employer, work location, platform name, publication date, Best_Commute_Time in minutes and Posting_Status, and SHALL present the text "unbekannt" (unknown) for a Best_Commute_Time stored as "unknown".
2. THE Web_App SHALL display per Job_Posting the Relevance_Verdict and, where a Relevance_Reason is stored, the Relevance_Reason.
3. THE Web_App SHALL mark per Job_Posting whether the Relevance_Verdict was set by the Relevance_Service or manually by the user.
4. THE Web_App SHALL identify the Relevance_Verdict of a Job_Posting through text in addition to colour.
5. THE Web_App SHALL provide filters with the following selectable values: Platform (every supported Platform individually selectable, default all Platform), reachability ("gut erreichbar", "nicht gut erreichbar", "unbekannt"), Posting_Status ("listed", "no longer listed"), marking with the values of the Interest_Flag ("unmarked", "not interesting") and the value "all", Relevance_Verdict with the values "relevant", "not relevant", "uncertain", "not assessed" and the value "all", and recording period (period with a from date and a to date), where several set filters have to be met simultaneously and the filters marking and Relevance_Verdict take effect independently of the filter Posting_Status.
6. WHERE a Job_Posting carries the Relevance_Verdict "not relevant", THE Web_App SHALL hide that Job_Posting in the default view and keep it displayable again through the filter Relevance_Verdict according to criterion 10.5.
7. THE Web_App SHALL provide sorting by recording time, publication date, Best_Commute_Time and Relevance_Verdict, each in ascending and descending direction, SHALL sort by recording time descending as the default, SHALL place Job_Posting with a Best_Commute_Time of "unknown" at the end of the list when sorting by Best_Commute_Time, and SHALL order the Relevance_Verdict values as "relevant" before "uncertain" before "not assessed" before "not relevant" when sorting by Relevance_Verdict.
8. WHEN the user opens a Job_Posting, THE Web_App SHALL display the complete description text of that Job_Posting as well as a labelled link to the source URL of the job advertisement.
9. WHERE the result list remaining after filtering and sorting contains more than 25 entries, THE Web_App SHALL present the Job_Posting page by page with at most 25 entries per page, display the first page when opening, offer navigation to the previous and the next page and display the current page number and the total number of pages.
10. WHEN the user marks a Job_Posting as "not interesting", THE Posting_Store SHALL set the Interest_Flag of that Job_Posting persistently to "not interesting" and leave the Posting_Status unchanged, and THE Web_App SHALL confirm the stored Interest_Flag within 2 seconds and offer a withdrawal of the Interest_Flag.
11. WHERE a Job_Posting carries the Interest_Flag "not interesting", THE Web_App SHALL hide that Job_Posting in the default view independently of its Posting_Status and keep it displayable again through the filter marking according to criterion 10.5.
12. IF the Posting_Store contains no Job_Posting, THEN THE Web_App SHALL display a German-language hint with the call to action "Suchlauf starten".
13. IF the Posting_Store contains at least one Job_Posting and the active filter combination yields no Job_Posting, THEN THE Web_App SHALL display a German-language hint about the empty filter result with the call to action "Filter zurücksetzen" (reset filters) and retain the set filters unchanged.
14. IF storing the Interest_Flag in the Posting_Store fails, THEN THE Web_App SHALL display a German-language error message with the next step and continue to list that Job_Posting with the Interest_Flag "unmarked" in the default view.
15. IF the description text of an opened Job_Posting is empty, THEN THE Web_App SHALL display a German-language hint about the missing description and continue to present the link to the source URL.

### Requirement 11: Highlighting the job postings of the last scrape run

**User Story:** As a user, I want to recognize the results of the last scrape run immediately, so that I only have to review the new positions.

#### Acceptance Criteria

1. THE Posting_Store SHALL store per Scrape_Run the identifier, the start time, the end time and exactly one Run_Outcome, and SHALL assign to every Job_Posting the identifier of the Scrape_Run of its first recording.
2. WHERE a Job_Posting is assigned to the Scrape_Run with the Run_Outcome "completed" and the latest end time (the most recently completed Scrape_Run) as the Scrape_Run of its first recording, THE Web_App SHALL mark that Job_Posting with the text label "neu" (new) and present it distinguishable from the remaining Job_Posting through a symbol in addition to colour.
3. WHERE the user has chosen no deviating sorting, THE Web_App SHALL display every Job_Posting marked with "neu" above every unmarked Job_Posting and sort within both groups by recording time descending.
4. WHEN a further Scrape_Run reaches the Run_Outcome "completed", THE Web_App SHALL assign the marking "neu" on the next build of the posting overview to the Job_Posting assigned to that Scrape_Run as the Scrape_Run of their first recording only, and SHALL remove the marking from every remaining Job_Posting.
5. THE Web_App SHALL display on the posting overview the start time, the end time and the Run_Outcome of the most recently completed Scrape_Run as well as the number of Job_Posting recorded for the first time in that Scrape_Run, the number of Job_Posting sighted again and the number of Job_Posting stored in total.
6. IF the Posting_Store contains no Scrape_Run with the Run_Outcome "completed", THEN THE Web_App SHALL mark no Job_Posting with "neu" and SHALL display, instead of the values according to acceptance criterion 11.5, a German-language hint that no Scrape_Run has been completed yet.
7. IF a Scrape_Run ends with a Run_Outcome other than "completed", THEN THE Web_App SHALL leave the marking "neu" and the values according to acceptance criterion 11.5 unchanged at the most recently completed Scrape_Run and display the Job_Posting recorded for the first time in that ended Scrape_Run without the marking "neu".
8. WHEN a Job_Posting with an already stored combination of platform name and Posting_Id is sighted again in a Scrape_Run, THE Posting_Store SHALL retain the assignment of that Job_Posting to the Scrape_Run of its first recording unchanged.

### Requirement 12: Starting and following a scrape run from the web application

**User Story:** As a user, I want to start a scrape run at the push of a button and follow its progress, so that I know what the Job_Tool is currently doing.

#### Acceptance Criteria

1. WHILE no Scrape_Run carries the status "running", WHEN the user triggers "Suchlauf starten" in the Web_App, THE API_Service SHALL create exactly one Scrape_Run with a start time and the status "running" and return its identifier to the Web_App within 2 seconds.
2. WHEN a Scrape_Run has been created, THE Web_App SHALL open the Log_View and present the status messages of that Scrape_Run in ascending order of their creation time, where at least the last 500 status messages of the Scrape_Run remain retrievable in the Log_View.
3. THE Scraper_Service SHALL write status messages per Platform for the start of the retrieval, the number of Result_Page read, the number of new Job_Posting, the number of updated Job_Posting and the completion to the Log_Stream, each with a creation time in ISO 8601 format, the identifier of the Scrape_Run, the platform name and a German-language message text.
4. THE Log_Stream SHALL transmit a status message to the Web_App within 2 seconds after its creation and SHALL transmit the status messages of a Scrape_Run in their order of creation.
5. WHILE a Scrape_Run carries the status "running", WHEN the user triggers "Suchlauf starten" again, THE API_Service SHALL create no further Scrape_Run, return the identifier of the running Scrape_Run and supply a hint that a Scrape_Run is already running.
6. WHILE a Scrape_Run carries the status "running", THE Web_App SHALL display the operable button "Suchlauf abbrechen" (cancel scrape run) in the Log_View.
7. WHEN the user triggers "Suchlauf abbrechen" for a Scrape_Run with the status "running", THE Scraper_Service SHALL end the running retrievals within 10 seconds, retain the already stored Job_Posting unchanged, set the Run_Outcome "cancelled by user" with an end time and write the cancellation as a status message to the Log_Stream.
8. WHEN the user closes the Log_View, THE Scraper_Service SHALL continue the Scrape_Run unchanged and write further status messages to the Log_Stream.
9. WHEN the user reopens the Log_View of a Scrape_Run with the status "running", THE Web_App SHALL reload the previous status messages of that Scrape_Run within 3 seconds, present them completely and without duplication and continue the running transmission.
10. WHILE the Log_View is open, WHEN a Scrape_Run ends, THE Web_App SHALL display a summary with the Run_Outcome, the runtime in minutes and seconds as well as, per Platform, the Platform_Status, the number of new Job_Posting and the number of updated Job_Posting.
11. IF the connection of the Log_Stream breaks during a Scrape_Run, THEN THE Web_App SHALL display a hint about the interrupted transmission and re-establish the connection at most five times with an interval of at least 2 seconds each.
12. IF the Web_App establishes no connection to the Log_Stream after five reconnection attempts, THEN THE Web_App SHALL display a hint with the call to action "Übertragung erneut verbinden" (reconnect transmission) and leave the running Scrape_Run untouched.
13. IF the API_Service cannot create a requested Scrape_Run, THEN THE API_Service SHALL create no Scrape_Run and return an error response with the cause to the Web_App.
14. IF the user triggers "Suchlauf abbrechen" for a Scrape_Run without the status "running", THEN THE API_Service SHALL reject the cancellation and return the stored Run_Outcome of that Scrape_Run.

### Requirement 13: Robust and considerate retrieval

**User Story:** As the operator of the Job_Tool, I want to query the platforms gently and tolerate individual failures, so that a scrape run reliably leads to results.

#### Acceptance Criteria

1. IF a Platform_Adapter ends a retrieval with an error, THEN THE Scraper_Service SHALL report the error with platform name and page number in the Log_Stream, set the Platform_Status of that Platform in the Scrape_Run to "failed", retain the Job_Posting stored for that Platform so far in the Posting_Store and execute the Platform_Adapter of the remaining activated Platform completely.
2. THE Platform_Adapter SHALL wait at least 2 seconds between the end of one page request of a Platform and the start of the next page request of the same Platform, measured from the arrival of the preceding response or its abort until the sending of the next request.
3. THE Platform_Adapter SHALL retrieve at most 10 Result_Page per Platform and Scrape_Run and SHALL end the retrieval of that Platform after retrieving the 10th Result_Page as well as report the Platform_Status "page limit reached" in the Log_Stream.
4. IF a page request delivers no result within 30 seconds after sending the request, THEN THE Platform_Adapter SHALL abort the retrieval and repeat the same page request at most twice, with a waiting time of at least 2 seconds before each repetition, so that at most 3 retrieval attempts occur per Result_Page.
5. IF a Platform reports an exceeded permitted fetch rate in a response, THEN THE Platform_Adapter SHALL send no further request to that Platform in the running Scrape_Run, report the Platform_Status "fetch rate limited" with platform name and page number in the Log_Stream and retain the Job_Posting of that Platform normalized so far in the Posting_Store.
6. WHEN the runtime of a Scrape_Run, measured from its start time, reaches 30 minutes, THE Scraper_Service SHALL send no further request to a Platform, end the running retrievals within 10 seconds, retain the already stored Job_Posting in the Posting_Store, set the Platform_Status of every unfinished Platform to "cancelled by time limit" and set the Run_Outcome of the Scrape_Run to "cancelled by time limit".
7. FOR ALL execution orders of the activated Platform_Adapter of a Scrape_Run, THE Scraper_Service SHALL produce from the same initial state of the Posting_Store and the same Platform results a final state of the Posting_Store that agrees in the set of Job_Posting, in every field per Job_Posting according to acceptance criterion 6.3, in the Posting_Status per Job_Posting and in the Platform_Status per Platform, where the order of the records and the concrete times of the timestamps are disregarded (confluence property).
8. IF all retrieval attempts of a Result_Page permitted by acceptance criterion 13.4 remain without a result, THEN THE Platform_Adapter SHALL end the retrieval of that Platform, report the Platform_Status "failed" with platform name and page number in the Log_Stream and pass the Job_Posting normalized up to that Result_Page to the Posting_Store.
9. THE Scraper_Service SHALL execute at most one page request per Platform at a time and at most 4 Platform_Adapter at a time.

### Requirement 14: Platform etiquette and operating constraints

**User Story:** As the operator of the Job_Tool, I want to respect the rules the platforms publish and keep the operating setup transparent, so that private use stays defensible.

#### Acceptance Criteria

1. WHEN a Platform_Adapter begins the first retrieval of a Platform in a Scrape_Run, THE Platform_Adapter SHALL retrieve the robots.txt of that Platform before the first page request, evaluate it for every intended path and reuse the result for the remaining duration of that Scrape_Run.
2. IF the robots.txt forbids the retrieval of an intended path, THEN THE Platform_Adapter SHALL execute no page request for that path, store no Job_Posting of that Platform and report the Platform_Status "excluded by robots.txt" with the platform name in the Log_Stream, while the Scraper_Service continues to execute the remaining Platform_Adapter.
3. IF the robots.txt of a Platform is not retrievable within 10 seconds or remains unevaluable, THEN THE Platform_Adapter SHALL refrain from retrieving that Platform and report the Platform_Status "robots.txt unavailable" with the platform name in the Log_Stream.
4. WHERE the robots.txt states a waiting time between two retrievals of more than 2 seconds for the retrieving user agent, THE Platform_Adapter SHALL respect that stated waiting time instead of the waiting time from acceptance criterion 13.2.
5. THE Platform_Adapter SHALL send an unchanged user agent with every retrieval that contains the name of the Job_Tool, the statement of private use and a contact detail read from the local environment file, and that identifies the Job_Tool as such rather than imitating the identification of a common browser.
6. THE Job_Tool SHALL restrict every Platform request to content reachable without sign-in according to acceptance criterion 7.1 and SHALL end the retrieval of a Platform that presents a Captcha page or bot check page according to acceptance criterion 7.6.
7. THE Job_Tool SHALL maintain exactly one documentation file per Platform_Adapter that contains the source URL of the retrieved result list, the retrieval scope with the retrieved paths, the maximum number of pages per Scrape_Run and the respected waiting time, as well as the date of the last review of the terms of use in ISO 8601 format.
8. WHEN the user opens the landing page of the Web_App, THE Web_App SHALL display a German-language hint visible without scrolling that names the private purpose of use of the Job_Tool and states whether the Relevance_Service is currently activated.
9. THE Job_Tool SHALL read every API key of the Routing_Provider and of the AI_Provider from the local environment file only and SHALL replace an API key value with a fixed mask in every output to the Log_Stream and to the Web_App.

### Requirement 15: AI relevance assessment of job postings

**User Story:** As a user, I want each found position assessed for relevance with a short German-language justification, so that I can concentrate on the positions that match my target role.

#### Acceptance Criteria

1. WHEN a Job_Posting is recorded for the first time in a Scrape_Run and the Relevance_Service is activated, THE Relevance_Service SHALL request exactly one assessment from the AI_Provider and store the Relevance_Verdict, the Relevance_Reason, the model name and the assessment time as an ISO 8601 timestamp in UTC in the Posting_Store.
2. WHEN the Relevance_Service requests an assessment, THE Relevance_Service SHALL transmit the title, the employer, the work location, the publication date and the description text truncated to at most 4,000 characters of that Job_Posting, together with the effective Search_Profile of its Platform as the assessment benchmark.
3. THE Relevance_Reason SHALL be written in German and SHALL contain at most 300 characters.
4. WHERE the Relevance_Verdict of a Job_Posting is "not relevant" or "uncertain", THE Relevance_Reason SHALL name the concrete reason, for example a deviating field of expertise, a deviating seniority level, a work location outside the search area, or recruitment agency placement instead of permanent employment.
5. WHILE the title and the description text of an already assessed Job_Posting remain unchanged, WHEN a following Scrape_Run records that Job_Posting, THE Relevance_Service SHALL retain the stored assessment and request no further assessment for that Job_Posting.
6. WHEN a following Scrape_Run records an already assessed Job_Posting with a changed title or a changed description text, THE Relevance_Service SHALL request exactly one new assessment and overwrite the Relevance_Verdict, the Relevance_Reason, the model name and the assessment time of that Job_Posting.
7. THE Relevance_Service SHALL request at most a configurable upper limit of assessments per Scrape_Run, with the default value 200, store every remaining Job_Posting with the Relevance_Verdict "not assessed" and report reaching that upper limit in the Log_Stream.
8. THE Relevance_Service SHALL send at most a configurable number of simultaneous requests to the AI_Provider, with the default value 4.
9. THE Job_Tool SHALL provide a switch in the local environment file that deactivates the Relevance_Service, so that the operator limits the cost of AI_Provider requests and operates the Job_Tool without an AI_Provider account.
10. IF no API key for the AI_Provider is present in the local environment file or the Relevance_Service is deactivated by the switch according to acceptance criterion 15.9, THEN THE Relevance_Service SHALL send no request, store every Job_Posting with the Relevance_Verdict "not assessed", and THE Job_Tool SHALL keep every remaining function fully available.
11. IF a request to the AI_Provider fails, exceeds a time limit of 30 seconds or reports a rate limit, THEN THE Relevance_Service SHALL repeat that request at most twice with an increasing interval and afterwards store the Relevance_Verdict "not assessed" with a German-language note in the Relevance_Reason and continue the Scrape_Run.
12. IF the response of the AI_Provider deviates from the expected structured format or contains a Relevance_Verdict outside the permitted value list, THEN THE Relevance_Service SHALL discard that response, store the Relevance_Verdict "not assessed" and report the incident in the Log_Stream.
13. THE Relevance_Service SHALL perform an assessment after the Job_Posting has been stored in the Posting_Store and SHALL let the Scrape_Run proceed while assessments are pending, so that a Job_Posting is visible in the Web_App before its assessment and the runtime limit according to acceptance criterion 13.6 stays unaffected.
14. FOR ALL responses of the AI_Provider, THE Relevance_Service SHALL yield from reading a response either exactly one Relevance_Verdict from the permitted value list together with a Relevance_Reason of at most 300 characters or an error, and SHALL store every Job_Posting with exactly one Relevance_Verdict (totality property of the response parser).
15. WHEN the user overrides the Relevance_Verdict of a Job_Posting manually in the Web_App, THE Posting_Store SHALL store that manual assessment persistently, mark it as "manuell gesetzt" (set manually) and retain it in every following Scrape_Run in place of an assessment by the Relevance_Service.
16. WHEN a Scrape_Run ends, THE Relevance_Service SHALL write the number of assessed Job_Posting, the number of Job_Posting with the Relevance_Verdict "not relevant" and the number of Job_Posting with the Relevance_Verdict "not assessed" to the Log_Stream.
17. THE Job_Tool SHALL use the AI_Provider for the relevance assessment according to acceptance criterion 15.1 and for the normalization of work locations according to acceptance criterion 8.6 only, and SHALL derive the scraping selectors and the Platform requests of every Platform_Adapter from the source code of that Platform_Adapter without involving the AI_Provider.

### Requirement 16: Steering docs for further development

**User Story:** As a developer, I want the project context and the conventions written down, so that further work on the Job_Tool stays consistent.

#### Acceptance Criteria

1. THE Job_Tool SHALL provide at least four Steering_Docs in Markdown format in the directory `.kiro/steering` that together cover the topics of acceptance criteria 16.2 to 16.8.
2. THE Steering_Docs SHALL describe the project context in a named section and name in that section the purpose of the Job_Tool, the single non-technical target user, German as the language of the user interface as well as the local operating model with PostgreSQL in a Docker container on a developer machine and without a cloud deployment.
3. THE Steering_Docs SHALL describe the conventions for a Platform_Adapter in a named section and name in that section the uniform adapter interface, the normalization of a Job_Posting onto the eight fields from acceptance criterion 6.3, the Criterion_Field supported per Platform, the minimum waiting time of 2 seconds between two page requests, the upper limit of 10 Result_Page per Platform and Scrape_Run as well as the tests required per Platform_Adapter with at least one success case and at least one error case.
4. THE Steering_Docs SHALL describe the local development and start flow in a named section and name in that section the steps of the Start_Script according to acceptance criterion 1.1 as well as the quality steps formatting, linting, type checking, build and tests with the command to run for each step.
5. THE Steering_Docs SHALL name the steps for adding a further Platform_Adapter as a numbered sequence, where each step states the file to create or change and the command to run.
6. THE Steering_Docs SHALL record that the Default_Search_Profile and every Platform_Override live in the source code, name the source file of each constant and state that a change takes effect by editing that file and restarting the API_Service according to acceptance criterion 3.9.
7. THE Steering_Docs SHALL describe the conventions for the Relevance_Service and name in that section the construction of the prompt, the expected structured response format, the caching of assessments according to acceptance criterion 15.5, the cost limits according to acceptance criteria 15.7 and 15.8 as well as the behaviour without an API key according to acceptance criterion 15.10.
8. THE Steering_Docs SHALL record the language convention that requirements, Steering_Docs, source code and code comments are written in English and that the texts of the user interface and every Relevance_Reason are written in German.
9. WHERE a Steering_Doc contains a front matter block, THE Steering_Doc SHALL set in the field `inclusion` exactly one of the values `always`, `fileMatch`, `manual` or `auto`; without a front matter block the file counts as always included.
10. THE Steering_Docs SHALL be written in English and SHALL use the terms of the glossary of this document unchanged.
11. WHEN a further Platform_Adapter is added or the start flow is changed, THE Steering_Docs SHALL be brought to the new state within the same change set.
