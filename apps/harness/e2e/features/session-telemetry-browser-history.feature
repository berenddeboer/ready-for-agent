Feature: Route Session Telemetry through browser history
  Opening Session Telemetry from Pipeline, Repos, or Completed uses the same
  `/session/<work-item-id>/telemetry` path so Back closes the dialog, Forward
  reopens it, and Close stays synchronized with the browser location.

  Background:
    Given the Harness has Session Telemetry fixtures
    And the Harness has a configured default build model

  Scenario: Pipeline open pushes Work Item telemetry path and preserves theme search
    When I open the home page with theme dark
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the missing-session fixture from Pipeline
    Then the browser location is the Session Telemetry path for the missing-session fixture with theme dark
    And the Session usage dialog is visible
    And the Session usage dialog shows the missing Session Telemetry state
    And the Pipeline jobs tab is active
    And the Pipeline remains visible under the dialog

  Scenario: Browser Back closes telemetry and Forward reopens the same Work Item
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the missing-session fixture from Pipeline
    Then the browser location is the Session Telemetry path for the missing-session fixture
    When I go back in the browser
    Then the Session usage dialog is hidden
    And the browser location is the home path
    When I go forward in the browser
    Then the Session usage dialog is visible
    And the browser location is the Session Telemetry path for the missing-session fixture
    And the Session usage dialog shows the missing Session Telemetry state

  Scenario: Close returns to the originating Pipeline location
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the missing-session fixture from Pipeline
    Then the browser location is the Session Telemetry path for the missing-session fixture
    When I close the Session usage dialog
    Then the Session usage dialog is hidden
    And the browser location is the home path

  Scenario: Repos open uses the same canonical telemetry route
    When I open the Repos page
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the missing-session fixture from Repos
    Then the browser location is the Session Telemetry path for the missing-session fixture
    And the Session usage dialog is visible
    And the Session usage dialog shows the missing Session Telemetry state
    And the Repos jobs tab is active
    And Repos remains visible under the dialog

  Scenario: Browser Back and Forward from Repos restore origin and reopen
    When I open the Repos page
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the missing-session fixture from Repos
    Then the browser location is the Session Telemetry path for the missing-session fixture
    When I go back in the browser
    Then the Session usage dialog is hidden
    And the browser location is the repos path
    When I go forward in the browser
    Then the Session usage dialog is visible
    And the browser location is the Session Telemetry path for the missing-session fixture

  Scenario: Close returns to the originating Repos location
    When I open the Repos page
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the missing-session fixture from Repos
    Then the browser location is the Session Telemetry path for the missing-session fixture
    When I close the Session usage dialog
    Then the Session usage dialog is hidden
    And the browser location is the repos path

  Scenario: Completed open uses the same canonical telemetry route
    When I open the Completed page
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the completed fixture from Completed
    Then the browser location is the Session Telemetry path for the completed fixture
    And the Session usage dialog is visible
    And the Session usage dialog shows the missing Session Telemetry state

  Scenario: Browser Back and Forward from Completed restore origin and reopen
    When I open the Completed page
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the completed fixture from Completed
    Then the browser location is the Session Telemetry path for the completed fixture
    When I go back in the browser
    Then the Session usage dialog is hidden
    And the browser location is the completed path
    When I go forward in the browser
    Then the Session usage dialog is visible
    And the browser location is the Session Telemetry path for the completed fixture

  Scenario: Close returns to the originating Completed location
    When I open the Completed page
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the completed fixture from Completed
    Then the browser location is the Session Telemetry path for the completed fixture
    When I close the Session usage dialog
    Then the Session usage dialog is hidden
    And the browser location is the completed path

  Scenario: Completed Next pushes page 2 into the URL
    When I open the Completed page
    And I cancel the Harness settings dialog if present
    And I navigate to the next Completed page
    Then the browser location is Completed page 2
    And Completed page 2 is visible

  Scenario: Completed page 2 is directly addressable
    When I open Completed page 2 directly
    And I cancel the Harness settings dialog if present
    Then the browser location is Completed page 2
    And Completed page 2 is visible

  Scenario: Invalid Completed page search resolves to canonical page 1
    When I open Completed with invalid page search
    And I cancel the Harness settings dialog if present
    Then the browser location is canonical Completed page 1

  Scenario: Page-2 telemetry retains Completed page and scroll on Close
    When I open Completed page 2 directly
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the page-2 fixture from Completed
    Then the browser location is the Session Telemetry path for the page-2 fixture
    And the Session usage dialog is visible
    And Completed page 2 remains visible under the dialog
    And the Completed jobs tab is active
    And the Completed scroll position is preserved
    When I close the Session usage dialog
    Then the browser location is Completed page 2
    And Completed page 2 is visible
    And the Completed scroll position is preserved

  Scenario: Back and Forward retain Completed page 2 and reopen telemetry
    When I open Completed page 2 directly
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the page-2 fixture from Completed
    Then the browser location is the Session Telemetry path for the page-2 fixture
    When I go back in the browser
    Then the Session usage dialog is hidden
    And the browser location is Completed page 2
    And Completed page 2 is visible
    And the Completed scroll position is preserved
    When I go forward in the browser
    Then the Session usage dialog is visible
    And the browser location is the Session Telemetry path for the page-2 fixture
    And Completed page 2 remains visible under the dialog
    And the Completed jobs tab is active

  Scenario: Escape returns to Completed page 2
    When I open Completed page 2 directly
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the page-2 fixture from Completed
    When I press Escape
    Then the Session usage dialog is hidden
    And the browser location is Completed page 2
    And Completed page 2 is visible

  Scenario: Refreshing an in-app masked telemetry URL uses canonical Pipeline
    When I open Completed page 2 directly
    And I cancel the Harness settings dialog if present
    And I open Session Telemetry for the page-2 fixture from Completed
    Then the browser location is the Session Telemetry path for the page-2 fixture
    When I refresh the page
    Then the Session usage dialog is visible
    And the browser location is the Session Telemetry path for the page-2 fixture
    And the Pipeline jobs tab is active
    And the Pipeline remains visible under the dialog
    When I close the Session usage dialog
    Then the Session usage dialog is hidden
    And the browser location is the home path

  Scenario: Direct telemetry navigation shows the dialog over Pipeline
    When I open the missing-session Session Telemetry path directly
    Then the Session usage dialog is visible
    And the browser location is the Session Telemetry path for the missing-session fixture
    And the Pipeline jobs tab is active
    And the Session usage dialog shows the missing Session Telemetry state
    When I close the Session usage dialog
    Then the Session usage dialog is hidden
    And the browser location is the home path

  Scenario: Refreshing telemetry keeps the dialog open and closes to home
    When I open the missing-session Session Telemetry path directly
    Then the Session usage dialog is visible
    When I refresh the page
    Then the Session usage dialog is visible
    And the browser location is the Session Telemetry path for the missing-session fixture
    When I close the Session usage dialog
    Then the Session usage dialog is hidden
    And the browser location is the home path

  Scenario: Missing Work Item shows not-found inside the dialog
    When I open Session Telemetry for a missing Work Item directly
    Then the Session usage dialog is visible
    And the Session usage dialog shows Work Item not found
    When I close the Session usage dialog
    Then the Session usage dialog is hidden
    And the browser location is the home path

  Scenario: Unsupported backend telemetry remains distinct
    When I open the unsupported Session Telemetry path directly
    Then the Session usage dialog is visible
    And the Session usage dialog shows the unsupported Session Telemetry state

  Scenario: Query failure remains distinct from missing Work Item
    When Session Telemetry query is forced to fail
    And I open the missing-session Session Telemetry path directly
    Then the Session usage dialog is visible
    And the Session usage dialog shows a Session usage load error

  Scenario: Successful Session Telemetry remains distinct
    When Session Telemetry query returns available usage for the missing-session fixture
    And I open the missing-session Session Telemetry path directly
    Then the Session usage dialog is visible
    And the Session usage dialog shows successful Session Telemetry fields
