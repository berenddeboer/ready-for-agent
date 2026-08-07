Feature: Route Pipeline Session Telemetry through browser history
  Opening Session Telemetry from Pipeline uses
  `/session/<work-item-id>/telemetry` so Back closes the dialog, Forward
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
