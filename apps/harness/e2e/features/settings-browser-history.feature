@ui-history
Feature: Route Harness Settings through browser history
  Explicit Harness Settings opens use `/settings` so Back closes the dialog,
  Forward reopens it, and Save / Cancel / Escape stay synchronized with the
  browser location. In-app opens mask that URL over the current Pipeline,
  Repos, or Completed surface (issue #1146). Automatic first-run Settings
  stays local-only.

  Scenario: Explicit Settings open pushes /settings and preserves theme search
    Given the Harness has no configured Repositories
    When I open the home page with theme dark
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path with theme dark
    And the Harness settings dialog is visible
    And the Pipeline jobs tab is active
    And the Pipeline blank slate remains visible under the dialog

  Scenario: Browser Back closes Settings and Forward reopens with saved values
    Given the Harness has no configured Repositories
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path
    When I change the max concurrent Agent Turns draft to "9"
    And I go back in the browser
    Then the Harness settings dialog is hidden
    And the browser location is the home path
    When I go forward in the browser
    Then the Harness settings dialog is visible
    And the browser location is the settings path
    And the max concurrent Agent Turns field shows the saved value not "9"

  Scenario: Opening Settings from Repos keeps Repos mounted
    Given the Harness has a seeded Paused Repository
    And the Harness has a configured default build model
    When I open the Repos page
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path
    And the Harness settings dialog is visible
    And the Repos jobs tab is active
    And Repos remains visible under the dialog

  Scenario: Opening Settings from Completed keeps Completed mounted
    Given the Harness has no configured Repositories
    When I open the Completed page
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path
    And the Harness settings dialog is visible
    And the Completed jobs tab is active
    And Completed remains visible under the dialog

  Scenario: Opening Settings from Completed page 2 retains pagination
    Given the Harness has Session Telemetry fixtures
    And the Harness has a configured default build model
    When I open Completed page 2 directly
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path
    And the Harness settings dialog is visible
    And the Completed jobs tab is active
    And Completed page 2 remains visible under the Harness settings dialog
    When I cancel the Harness settings dialog
    Then the browser location is Completed page 2
    And Completed page 2 is visible

  Scenario: Cancel returns to the originating location
    Given the Harness has no configured Repositories
    When I open the Repos page
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path
    And the Repos jobs tab is active
    When I cancel the Harness settings dialog
    Then the Harness settings dialog is hidden
    And the browser location is the repos path

  Scenario: Escape returns to the originating location
    Given the Harness has no configured Repositories
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path
    When I press Escape in the Harness settings dialog
    Then the Harness settings dialog is hidden
    And the browser location is the home path

  Scenario: Successful Save returns to the originating location
    Given the Harness has no configured Repositories
    And the Harness has a configured default build model
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path
    When I save Harness settings without changing values
    Then the Harness settings dialog is hidden
    And the browser location is the home path

  Scenario: Failed Save keeps the dialog and /settings open
    Given the Harness has no configured Repositories
    And the Harness has a configured default build model
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path
    When Harness settings Save is forced to fail
    And I save Harness settings expecting failure
    Then the Harness settings dialog is visible
    And the browser location is the settings path
    And a settings save error is shown

  Scenario: Browser Back is blocked while Save is pending
    Given the Harness has no configured Repositories
    And the Harness has a configured default build model
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path
    When Harness settings Save is delayed
    And I start saving Harness settings
    And I go back in the browser while Save is pending
    Then the Harness settings dialog is visible
    And the browser location is the settings path
    When the delayed Harness settings Save completes
    Then the Harness settings dialog is hidden
    And the browser location is the home path

  Scenario: Direct /settings navigation shows the dialog over Pipeline
    Given the Harness has no configured Repositories
    When I open the settings path directly
    Then the Harness settings dialog is visible
    And the browser location is the settings path
    And the Pipeline jobs tab is active
    And the Pipeline blank slate remains visible under the dialog
    When I cancel the Harness settings dialog
    Then the Harness settings dialog is hidden
    And the browser location is the home path

  Scenario: Refreshing /settings keeps the dialog open and closes to home
    Given the Harness has no configured Repositories
    When I open the settings path directly
    Then the Harness settings dialog is visible
    When I refresh the page
    Then the Harness settings dialog is visible
    And the browser location is the settings path
    When I cancel the Harness settings dialog
    Then the Harness settings dialog is hidden
    And the browser location is the home path

  Scenario: Refresh after in-app open still closes to home with replace
    Given the Harness has no configured Repositories
    When I open the Repos page
    And I cancel the Harness settings dialog if present
    And I open Harness settings from the masthead
    Then the browser location is the settings path
    When I refresh the page
    Then the Harness settings dialog is visible
    And the browser location is the settings path
    When I cancel the Harness settings dialog
    Then the Harness settings dialog is hidden
    And the browser location is the home path

  Scenario: First-run Settings does not change the URL
    Given the Harness is empty with first-run settings required
    When I open the home page
    Then the Harness settings dialog is visible
    And the browser location is the home path
    When I complete and save Harness settings
    Then the Harness settings dialog is hidden
    And the browser location is the home path
